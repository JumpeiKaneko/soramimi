// --- [グローバル変数と定数] ---

const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioContext = null;
let mediaStreamSource = null;
let scriptProcessorNode = null;
let stream = null;
let randomTriggerInterval = null;
let monitoringGain = null;
let monitoringConnected = false; // track if mic -> monitoringGain -> destination is connected
let guaranteeTimer = null; // ensures at least one soramimi happens every N minutes

// Play a short, low-volume test tone to verify output on start
function playStartTestTone() {
    if (!audioContext) return;
    try {
        const testGain = audioContext.createGain();
        testGain.gain.setValueAtTime(0.06, audioContext.currentTime); // very low volume
        const osc = audioContext.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioContext.currentTime);
        osc.connect(testGain).connect(audioContext.destination);
        osc.start();
        osc.stop(audioContext.currentTime + 0.12);
        osc.onended = () => { try { osc.disconnect(); testGain.disconnect(); } catch (e) {} };
        updateLog('テストトーンを再生しました（音が出るか確認してください）');
    } catch (e) {
        console.warn('test tone failed', e);
    }
}

// アーカイブ設定
const ARCHIVE_QUEUE = []; // 録音済みセグメントを保持するキュー
const MAX_ARCHIVE_SEGMENTS = 300; // 最大セグメント数 (例: 10分 x 30セグメント/分 = 300)
const SAMPLE_RATE = 44100; // サンプルレート (Context作成後に正確な値を使用)
const BUFFER_SIZE = 4096; // ScriptProcessorNodeのバッファサイズ
const SEGMENT_MIN_SEC = 2; // 聞き間違いセグメントの最小秒数
const SEGMENT_MAX_SEC = 5; // 聞き間違いセグメントの最大秒数
// When selecting a past fragment, exclude any segments recorded within the last EXCLUDE_RECENT_MS
const EXCLUDE_RECENT_MS = 4000; // default: 4 seconds

// ランダムトリガー設定（動的に変更できる）
let TRIGGER_CHECK_INTERVAL = 10000; // ミリ秒（初期: 10秒ごとに抽選）
let TRIGGER_PROBABILITY = 0.05; // 0..1 の確率（初期: 5%）

// 追加のUI要素参照（DOMContentLoadedで初期化）
let probabilityInput = null;
let probabilityValue = null;
let intervalInput = null;
// manualTriggerButton removed per UX: no manual trigger
let sampleRateElement = null;
let recordingDot = null;
let logElement = null;

// DOM要素（DOMContentLoaded後に初期化）
let startButton = null;
let stopButton = null;
let statusElement = null;
let soraMimiStatus = null;
let archiveSizeElement = null;

// --- [アーカイブ蓄積ロジック] ---

/**
 * ScriptProcessorNodeのイベントハンドラ：リアルタイムで音声データを処理し、アーカイブキューに追加
 * @param {AudioProcessingEvent} event 
 */
function archiveAudio(event) {
    // リアルタイム音声データ（今回はモノラル前提）
    const inputBuffer = event.inputBuffer.getChannelData(0); 

    // 新しい配列にコピーしてタイムスタンプ付きでキューに追加
    const segmentCopy = new Float32Array(inputBuffer);
    ARCHIVE_QUEUE.push({ samples: segmentCopy, t: Date.now() });
    
    // キューの最大サイズを超えたら最も古いセグメントを削除（FIFO: 先入れ先出し）
    if (ARCHIVE_QUEUE.length > MAX_ARCHIVE_SEGMENTS) {
        ARCHIVE_QUEUE.shift();
    }
    
    // UIの更新 (多少頻繁にして確認しやすくする)
    if (ARCHIVE_QUEUE.length % 10 === 0) {
        if (archiveSizeElement) archiveSizeElement.textContent = `アーカイブサイズ: ${ARCHIVE_QUEUE.length} セグメント`;
        // サンプルレートや合計時間も更新
        if (sampleRateElement) {
            const sr = audioContext ? audioContext.sampleRate : SAMPLE_RATE;
            sampleRateElement.textContent = `サンプルレート: ${sr} Hz`;
        }
        updateLog(`アーカイブ更新: ${ARCHIVE_QUEUE.length} セグメント`);
    }
    // Lightweight debug: occasionally log RMS level to confirm audio input
    if (ARCHIVE_QUEUE.length % 50 === 0) {
        try {
            let sum = 0;
            for (let i = 0; i < segmentCopy.length; i++) { const v = segmentCopy[i]; sum += v*v; }
            const rms = Math.sqrt(sum / segmentCopy.length);
            console.log('Soramimi: archive segment RMS', rms.toFixed(5), 'len', segmentCopy.length);
            updateLog && updateLog(`入力レベル (RMS): ${rms.toFixed(5)}`);
        } catch(e){ }
    }
}

// --- [ランダム再生（Soramimi）ロジック] ---

/**
 * アーカイブからランダムにセグメントを選択し、演出を加えて再生
 */
function playRandomSoraMimi() {
    if (!audioContext || audioContext.state !== 'running' || ARCHIVE_QUEUE.length === 0) {
        // log why we're not playing
        try {
            if (!audioContext) console.warn('playRandomSoraMimi: no audioContext');
            else if (audioContext.state !== 'running') console.warn('playRandomSoraMimi: audioContext not running:', audioContext.state);
            else if (ARCHIVE_QUEUE.length === 0) console.warn('playRandomSoraMimi: archive empty');
            updateLog && updateLog('再生スキップ: 条件未達');
        } catch(e){}
        return;
    }
    // Ensure AudioContext resumed and monitoring remains connected so live return is always audible
    try { audioContext.resume().catch(()=>{}); } catch (e) {}
    try {
        if (!monitoringConnected && mediaStreamSource && monitoringGain) {
            mediaStreamSource.connect(monitoringGain);
            monitoringGain.connect(audioContext.destination);
            monitoringGain.gain.setValueAtTime(1.0, audioContext.currentTime);
            monitoringConnected = true;
        } else if (monitoringGain) {
            // ensure gain is set (in case it was modified elsewhere)
            monitoringGain.gain.setValueAtTime(1.0, audioContext.currentTime);
        }
    } catch (e) {
        console.warn('Could not ensure monitoring connection:', e);
    }
    
    if (soraMimiStatus) soraMimiStatus.textContent = '聞き間違い: 発生！';

    // 1. ランダムなセグメント（時間）を決定
    const segmentCount = ARCHIVE_QUEUE.length;
    const now = Date.now();
    // Build candidate indices excluding very recent segments so the selection feels like '過去'の音
    const candidateIndices = [];
    for (let i = 0; i < segmentCount; i++) {
        const seg = ARCHIVE_QUEUE[i];
        if (!seg || !seg.t) continue;
        if ((now - seg.t) > EXCLUDE_RECENT_MS) candidateIndices.push(i);
    }
    // If no candidates (e.g. early start), fall back to entire archive but log that we relaxed the rule
    let startIndex;
    if (candidateIndices.length === 0) {
        startIndex = Math.floor(Math.random() * segmentCount);
        updateLog(`候補無し（直近除外ルールを緩和）：startIndex=${startIndex}, archiveLength=${segmentCount}`);
    } else {
        startIndex = candidateIndices[Math.floor(Math.random() * candidateIndices.length)];
        updateLog(`選択: startIndex=${startIndex} (候補数=${candidateIndices.length}), archiveLength=${segmentCount}`);
    }

    // 2. 再生する断片の長さをランダムに決定 (2秒から5秒)
    const durationSec = SEGMENT_MIN_SEC + Math.random() * (SEGMENT_MAX_SEC - SEGMENT_MIN_SEC);
    const segmentLength = Math.round(durationSec * audioContext.sampleRate / BUFFER_SIZE) * BUFFER_SIZE;
    updateLog(`再生長さ: ${durationSec.toFixed(2)}s -> ${segmentLength} samples`);
    
    // 3. AudioBufferの作成
    const numChannels = 1; // モノラル
    const soraMimiBuffer = audioContext.createBuffer(numChannels, segmentLength, audioContext.sampleRate);
    const outputData = soraMimiBuffer.getChannelData(0);

    // 4. キューからバッファにデータをコピー
    let offset = 0;
    for (let i = 0; offset < segmentLength && i < segmentCount; i++) {
        // ARCHIVE_QUEUE の各要素は {samples, t}
        const segObj = ARCHIVE_QUEUE[(startIndex + i) % segmentCount];
        const segment = segObj ? segObj.samples : null;
        if (!segment) continue;
        // コピーする長さを決定 (バッファの残りサイズか、セグメントサイズか)
        const copyLength = Math.min(BUFFER_SIZE, segmentLength - offset, segment.length);
        outputData.set(segment.subarray(0, copyLength), offset);
        offset += copyLength;
    }
    updateLog(`バッファ作成: 出力長 ${outputData.length}, コピー済み ${offset} samples`);

    // 5. SourceNodeの作成と演出ノードの接続
    const sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = soraMimiBuffer;

    // 演出ノード: わずかなパンニングとフィルタリング
    const pannerNode = audioContext.createStereoPanner();
    const filterNode = audioContext.createBiquadFilter();
    
    // A. パンニング（-0.8から-0.2、または0.2から0.8の間でランダムに設定）
    pannerNode.pan.setValueAtTime(Math.random() > 0.5 ? Math.random() * 0.6 + 0.2 : -(Math.random() * 0.6 + 0.2), audioContext.currentTime);

    // B. フィルター（少し籠った「記憶の断片」のような音質に）
    filterNode.type = 'lowpass';
    filterNode.frequency.setValueAtTime(3000 + Math.random() * 1000, audioContext.currentTime); // 3-4kHzに設定

    // 接続: Source -> Filter -> Panner -> (replayGain -> Destination)
    sourceNode.connect(filterNode).connect(pannerNode);

    // 6. 再生
    // Attach a gain node for controlled replay level and connect panner to it
    const replayGain = audioContext.createGain();
    replayGain.gain.setValueAtTime(0.9, audioContext.currentTime);
    pannerNode.connect(replayGain).connect(audioContext.destination);
    // Visual cue: flash the tagline briefly so the audience links the audio event
    try {
        const taglineEl = document.querySelector('.tagline');
        if (taglineEl) {
            taglineEl.classList.add('flash');
            // remove after safety timeout (CSS animation will also end)
            setTimeout(() => { taglineEl.classList.remove('flash'); }, 900);
        }
        // Also make the recording lamp change pulse while this soramimi plays
        if (recordingDot) {
            recordingDot.classList.add('sora');
        }
    } catch (e) {
        // ignore DOM exceptions in non-browser contexts
    }

    sourceNode.start(0);

    // 7. 再生終了後のクリーンアップとステータス更新
    sourceNode.onended = () => {
        // すべてのノードを切断してメモリ解放
        sourceNode.disconnect();
        filterNode.disconnect();
        pannerNode.disconnect();
        // remove flash class in case it wasn't removed yet
        try {
            const taglineEl = document.querySelector('.tagline');
            if (taglineEl) taglineEl.classList.remove('flash');
            if (recordingDot) recordingDot.classList.remove('sora');
        } catch (e) {}
        if (soraMimiStatus) soraMimiStatus.textContent = '聞き間違い: なし';
        updateLog('聞き間違い再生終了');
    };
    updateLog('聞き間違い再生開始');
}

// Keyboard shortcut for testing: press 't' to force a soramimi (only when running)
window.addEventListener('keydown', (ev) => {
    if (ev.key === 't' || ev.key === 'T') {
        if (audioContext && audioContext.state === 'running') {
            updateLog('手動テストトリガー: t キー押下');
            try { playRandomSoraMimi(); } catch (e) { console.warn('manual trigger failed', e); }
        } else {
            updateLog('手動トリガー: AudioContext が実行中ではありません');
        }
    }
});


/**
 * ランダムトリガーを起動
 */
function startRandomTrigger() {
    // 既存のタイマーがある場合はクリアしてから再設定
    if (randomTriggerInterval) {
        clearInterval(randomTriggerInterval);
        randomTriggerInterval = null;
    }

    randomTriggerInterval = setInterval(() => {
        // 乱数を生成し、確率チェック
        const randomValue = Math.random();
        if (randomValue < TRIGGER_PROBABILITY && ARCHIVE_QUEUE.length > 10) {
            playRandomSoraMimi();
        }
    }, TRIGGER_CHECK_INTERVAL);
    updateLog(`ランダムトリガー開始：${TRIGGER_CHECK_INTERVAL/1000}s ごと、確率 ${Math.round(TRIGGER_PROBABILITY*100)}%`);
}

/**
 * Schedule a guaranteed soramimi between 1 and 5 minutes from now.
 * When the timer fires it will call playRandomSoraMimi() and reschedule itself.
 */
function scheduleNextGuaranteedTrigger(isFirst = false) {
    // clear existing
    if (guaranteeTimer) {
        clearTimeout(guaranteeTimer);
        guaranteeTimer = null;
    }
    // For the first scheduled trigger after start, guarantee it occurs within 30s.
    // Afterward, pick a randomized interval between 1s and 60s so the maximum wait is 60s.
    let nextMs;
    if (isFirst) {
        // 1..30 seconds
        nextMs = Math.floor(Math.random() * 30000) + 1000; // 1000..30000 ms
    } else {
        // 1..60 seconds
        nextMs = Math.floor(Math.random() * 60000) + 1000; // 1000..60000 ms
    }
    guaranteeTimer = setTimeout(() => {
        try {
            // Guard: only trigger if audio is running and we have archive
            if (audioContext && audioContext.state === 'running' && ARCHIVE_QUEUE.length > 0) {
                playRandomSoraMimi();
            }
        } finally {
            // always schedule next one
            scheduleNextGuaranteedTrigger();
        }
    }, nextMs);
    updateLog(`次の保証された聞き間違いまで: ${Math.round(nextMs/1000)}s`);
}


// --- [メインのアプリケーション制御] ---

/**
 * 録音/再生処理を開始
 */
function startSoramimi() {
    if (audioContext && audioContext.state === 'running') return;
    
    // AudioContextの初期化
    audioContext = new AudioContext();
    // Some browsers start the context suspended; ensure it's running after a user gesture
    audioContext.resume().catch(() => {});
    if (statusElement) statusElement.textContent = 'ステータス: マイクアクセス中...';

    // マイク入力の取得
    // Request mic with loopback-friendly constraints (disable echo/noise suppression so direct monitoring works)
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        .then(userStream => {
            stream = userStream;
            
            // 1. MediaStreamをSourceNodeに接続
            mediaStreamSource = audioContext.createMediaStreamSource(stream);
            
            // 2. Create a monitoring gain node and connect the mic to destination so user hears immediate input
            monitoringGain = audioContext.createGain();
            // default monitoring gain (slightly boosted to improve audibility on some devices)
            monitoringGain.gain.cancelScheduledValues(audioContext.currentTime);
            monitoringGain.gain.setValueAtTime(1.5, audioContext.currentTime);
            // connect only once to avoid duplicate connections
            try {
                if (!monitoringConnected) {
                    mediaStreamSource.connect(monitoringGain);
                    monitoringGain.connect(audioContext.destination);
                    monitoringConnected = true;
                    console.log('Soramimi: monitoring connected (mic -> monitoringGain -> destination)');
                    try { updateLog('モニタリング経路を接続しました'); } catch(e){}
                }
            } catch (e) {
                console.warn('monitoring connect failed', e);
            }

            // 3. ScriptProcessorNodeを作成してアーカイブ（録音）処理のみを行う
            // (非推奨だが互換性のために使用。将来的にはAudioWorkletへ移行推奨)
            scriptProcessorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
            // 4. アーカイブ処理をアサイン
            scriptProcessorNode.onaudioprocess = archiveAudio;
            // connect source -> scriptProcessorNode so onaudioprocess receives data, but DO NOT connect processor to destination
            mediaStreamSource.connect(scriptProcessorNode);
            console.log('Soramimi: scriptProcessor connected (onaudioprocess will run)');
            if (stream && stream.getAudioTracks) {
                try {
                    const tracks = stream.getAudioTracks();
                    console.log('Soramimi: audio tracks', tracks.map(t => ({id: t.id, enabled: t.enabled, kind: t.kind, label: t.label}))); 
                    updateLog && updateLog(`マイクトラック: ${tracks.length}`);
                } catch (e) { console.warn('track info failed', e); }
            }

            // Ensure the AudioContext is resumed (some browsers require explicit resume)
            try {
                audioContext.resume().then(() => {
                    console.log('Soramimi: audioContext resumed');
                    try { updateLog('AudioContext resumed'); } catch(e){}
                    // Play a very short test tone so the user can confirm output
                    playStartTestTone();
                }).catch(e => { console.warn('resume failed', e); });
            } catch(e){ console.warn('resume call failed', e); }

            // 5. ランダムトリガーの起動 (自動で挿入されるため手動トリガーは不要)
            startRandomTrigger();
                    // schedule guaranteed periodic soramimi (first one within 30s)
                    scheduleNextGuaranteedTrigger(true);

            // 状態の更新
            if (statusElement) statusElement.textContent = 'ステータス: 実行中（リアルタイム再生＆アーカイブ中）';
            if (startButton) startButton.disabled = true;
            if (stopButton) stopButton.disabled = false;
            // サンプルレート表示と録音インジケータ
            if (sampleRateElement) sampleRateElement.textContent = `サンプルレート: ${audioContext.sampleRate} Hz`;
            if (recordingDot) recordingDot.classList.add('is-recording');
            updateLog('録音開始');
        })
        .catch(err => {
            console.error('マイクアクセスエラー:', err);
            statusElement.textContent = `ステータス: エラーが発生しました (${err.name})`;
            alert('マイクへのアクセスを許可してください。');
            stopSoramimi();
        });
}

/**
 * 停止処理
 */
function stopSoramimi() {
    // タイマーをクリア
    if (randomTriggerInterval) {
        clearInterval(randomTriggerInterval);
        randomTriggerInterval = null;
    }
    // guaranteed trigger
    if (guaranteeTimer) {
        clearTimeout(guaranteeTimer);
        guaranteeTimer = null;
    }

    // ストリームのトラックを停止
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }

    // AudioContextとノードのクリーンアップ
    if (audioContext) {
        audioContext.close().then(() => {
            audioContext = null;
            mediaStreamSource = null;
            scriptProcessorNode = null;
            monitoringConnected = false;
            
            // UIの更新
            if (statusElement) statusElement.textContent = 'ステータス: 停止中';
            if (soraMimiStatus) soraMimiStatus.textContent = '聞き間違い: なし';
            if (startButton) startButton.disabled = false;
            if (stopButton) stopButton.disabled = true;
            
            // アーカイブをクリア
            ARCHIVE_QUEUE.length = 0; 
            if (archiveSizeElement) archiveSizeElement.textContent = `アーカイブサイズ: 0 セグメント`;
            if (sampleRateElement) sampleRateElement.textContent = `サンプルレート: -`;
            if (recordingDot) recordingDot.classList.remove('is-recording');
            updateLog('録音停止');
            
            console.log('Soramimi停止完了。');
        });
    }
}


// --- [イベントリスナー] ---

// DOMContentLoadedで要素を取得してイベントを登録
window.addEventListener('DOMContentLoaded', () => {
    startButton = document.getElementById('startButton');
    stopButton = document.getElementById('stopButton');
    statusElement = document.getElementById('status');
    soraMimiStatus = document.getElementById('soraMimiStatus');
    archiveSizeElement = document.getElementById('archiveSize');
    // 追加要素
    probabilityInput = document.getElementById('probabilityInput');
    probabilityValue = document.getElementById('probabilityValue');
    intervalInput = document.getElementById('intervalInput');
    sampleRateElement = document.getElementById('sampleRate');
    recordingDot = document.getElementById('recordingDot');
    logElement = document.getElementById('log');
    // split title element for interactive parallax
    const splitTitle = document.getElementById('splitTitle');
    const titleTop = splitTitle ? splitTitle.querySelector('.layer.top') : null;
    const titleBottom = splitTitle ? splitTitle.querySelector('.layer.bottom') : null;

    // mousemove parallax effect for title
    if (splitTitle && titleTop && titleBottom) {
        splitTitle.addEventListener('mousemove', (ev) => {
            const rect = splitTitle.getBoundingClientRect();
            const x = (ev.clientX - rect.left) / rect.width - 0.5; // -0.5 .. 0.5
            const y = (ev.clientY - rect.top) / rect.height - 0.5;
            const tx = x * 12; // horizontal translate px
            const ty = y * 10; // vertical translate px
            // top layer: slight opposite move
            titleTop.style.transform = `translate(${ -tx }px, ${ -ty }px)`;
            // bottom layer: small offset to create split / double-exposure look
            titleBottom.style.transform = `translate(${ tx }px, ${ ty + 6 }px)`;
        });
        // reset on mouseleave
        splitTitle.addEventListener('mouseleave', () => {
            titleTop.style.transform = '';
            titleBottom.style.transform = '';
        });
    }

    // 初期UI状態
    if (archiveSizeElement) archiveSizeElement.textContent = `アーカイブサイズ: ${ARCHIVE_QUEUE.length} セグメント`;
    if (startButton) startButton.addEventListener('click', startSoramimi);
    if (stopButton) stopButton.addEventListener('click', stopSoramimi);
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;

    // probability slider wiring
    if (probabilityInput && probabilityValue) {
        probabilityValue.textContent = `${probabilityInput.value}%`;
        probabilityInput.addEventListener('input', (e) => {
            const v = Number(e.target.value);
            probabilityValue.textContent = `${v}%`;
            TRIGGER_PROBABILITY = v / 100;
            updateLog(`確率変更: ${v}%`);
        });
    }

    // interval input wiring (秒 -> ms)
    if (intervalInput) {
        intervalInput.value = TRIGGER_CHECK_INTERVAL / 1000;
        intervalInput.addEventListener('change', (e) => {
            const seconds = Number(e.target.value) || 1;
            TRIGGER_CHECK_INTERVAL = Math.max(1000, Math.floor(seconds * 1000));
            // 再起動
            if (audioContext && audioContext.state === 'running') startRandomTrigger();
            updateLog(`チェック間隔変更: ${Math.round(TRIGGER_CHECK_INTERVAL/1000)}s`);
        });
    }

    // manual trigger removed (UX: automatic only)
});

// シンプルなログ表示補助
function updateLog(message) {
    if (!logElement) return;
    const t = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.textContent = `[${t}] ${message}`;
    logElement.prepend(entry);
    // 過度の高さを防ぐ（最大200行）
    while (logElement.children.length > 200) logElement.removeChild(logElement.lastChild);
}

