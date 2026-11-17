"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "@/lib/supabase";
import {
  Car,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  SkipForward,
  StopCircle,
  Play,
  Database,
  Music,
  Activity,
  CloudRain,
  Compass,
  Clock,
  Zap,
  ShieldAlert,
  CheckCircle2,
  SlidersHorizontal,
} from "lucide-react";

// ==========================================
// 型定義
// ==========================================
interface Track {
  id: number;
  name: string;
  artist: string;
  valence: number;
  energy: number;
  bpm: number;
  instrumentalness: number;
  acousticness: number;
  spotifyId: string;
}

type ExperimentPhase = "setup" | "running" | "finished";
type IsoStrategy = "Arousal First" | "Valence First" | "Linear" | "Dynamic";

const clamp = (val: number, min: number, max: number) =>
  Math.min(Math.max(val, min), max);

export default function SdvExperimentApp() {
  // 楽曲DB
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [onlyPlayableTracks, setOnlyPlayableTracks] = useState<boolean>(true);

  // 実験フェーズ＆被験者情報
  const [phase, setPhase] = useState<ExperimentPhase>("setup");
  const [participantId, setParticipantId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  const [setupStep, setSetupStep] = useState<1 | 2 | 3>(1); // 1:ID入力, 2:Who, 3:Mood

  // 2タップ入力
  const [selectedWho, setSelectedWho] = useState<string>("Solo");
  const [selectedMood, setSelectedMood] = useState<string>("Chill");

  // 走行コンディション（実験実施者用コントロールパネルで操作）
  const [showControlPanel, setShowControlPanel] = useState<boolean>(true);
  const [speedKph, setSpeedKph] = useState<number>(50);
  const [drivingMinutes, setDrivingMinutes] = useState<number>(15);
  const [weather, setWeather] = useState<string>("Sunny");
  const [season, setSeason] = useState<string>("Autumn");
  const [timeOfDay, setTimeOfDay] = useState<string>("Day");
  const [location, setLocation] = useState<string>("Normal");
  const [tempC, setTempC] = useState<number>(20);
  const [avgTempC] = useState<number>(18);

  // 拡張A（緊急割り込み）＆ 拡張B（環境変化通知）
  const [emergencyActive, setEmergencyActive] = useState<boolean>(false);
  const [emergencyReason, setEmergencyReason] = useState<string>("");
  const [isDrowsy, setIsDrowsy] = useState<boolean>(false);
  const [isHardBraking, setIsHardBraking] = useState<boolean>(false);
  const [envChangeBanner, setEnvChangeBanner] = useState<string | null>(null);

  // DB保存ステータス＆ログカウント
  const [dbStatus, setDbStatus] = useState<string>("待機中");
  const [savedCount, setSavedCount] = useState<number>(0);
  const [evalComment, setEvalComment] = useState<string>("");
  const [feedbackToast, setFeedbackToast] = useState<string | null>(null);

  // 学習オフセット（セッション内閉ループ適応）
  const [learnedShiftV, setLearnedShiftV] = useState<number>(0);
  const [learnedShiftE, setLearnedShiftE] = useState<number>(0);

  const prevEnvRef = useRef({ weather, location, timeOfDay });

  // 1. public/sdv_music_db.csv 読み込み
  useEffect(() => {
    fetch("/sdv_music_db.csv")
      .then((res) => res.text())
      .then((csvText) => {
        const lines = csvText.trim().split(/\r?\n/).slice(1);
        const parsed: Track[] = lines
          .map((line) => {
            const p = line.split(",");
            if (p.length < 8) return null;
            return {
              id: Number(p[0]),
              name: p[1]?.trim() || "",
              artist: p[2]?.trim() || "",
              valence: parseFloat(p[3]),
              energy: parseFloat(p[4]),
              bpm: parseInt(p[5]),
              instrumentalness: parseFloat(p[6]),
              acousticness: parseFloat(p[7]),
              spotifyId: (p[8] || "").trim(),
            };
          })
          .filter((t): t is Track => t !== null && !isNaN(t.valence));
        setTracks(parsed);
      })
      .catch((err) => console.error("CSV読込エラー:", err));
  }, []);

  // ====================================================================
  // 中間処理エンジン（ISO原理 4戦略 + ラッセル円環モデル + 環境/CAN補正）
  // ====================================================================
  const middleLayer = useMemo(() => {
    const logs: string[] = [];

    // 1. Who ベースレンジ
    let minV = 0.2, maxV = 1.0, minE = 0.1, maxE = 0.9;
    if (selectedWho === "Partner") { minV = 0.3; maxV = 0.7; minE = 0.2; maxE = 0.7; }
    if (selectedWho === "Friends") { minV = 0.5; maxV = 1.0; minE = 0.5; maxE = 0.9; }
    if (selectedWho === "Group")   { minV = 0.3; maxV = 0.8; minE = 0.2; maxE = 0.6; }

    // 2. Mood シフト
    let shiftV = 0, shiftE = 0;
    if (selectedMood === "Chill")   { shiftV = 0.1; shiftE = -0.2; }
    if (selectedMood === "Energy")  { shiftV = 0.2; shiftE = 0.3; }
    if (selectedMood === "Awake")   { shiftV = 0.0; shiftE = 0.4; }
    if (selectedMood === "Excited") { shiftV = 0.3; shiftE = 0.2; }
    if (selectedMood === "Night")   { shiftV = 0.0; shiftE = -0.3; }

    if (selectedMood !== "Mix") {
      minV = clamp(minV + shiftV, 0.2, 1.0);
      maxV = clamp(maxV + shiftV, 0.2, 1.0);
      minE = clamp(minE + shiftE, 0.1, 0.9);
      maxE = clamp(maxE + shiftE, 0.1, 0.9);
    }
    const twoTapBox = { minV, maxV, minE, maxE };
    logs.push(`[2タップ基準] ${selectedWho}×${selectedMood} ➔ V:[${minV.toFixed(2)},${maxV.toFixed(2)}], E:[${minE.toFixed(2)},${maxE.toFixed(2)}]`);

    // 3. ISO原理の遷移戦略決定
    let isoStrategy: IsoStrategy = "Linear";
    if (isDrowsy) {
      isoStrategy = "Arousal First";
    } else if (speedKph < 15 || isHardBraking) {
      isoStrategy = "Valence First";
    } else if (drivingMinutes >= 60) {
      isoStrategy = "Dynamic";
    } else {
      isoStrategy = "Linear";
    }
    logs.push(`[ISO遷移戦略] ${isoStrategy} を選択`);

    // 4. 追加パラメータ初期値
    let minBpm = 60, maxBpm = 200;
    let minInst = 0.0, maxInst = 1.0;
    let minAc = 0.0, maxAc = 1.0;
    let envV = learnedShiftV, envE = learnedShiftE;

    // 天気補正（Anglada-Tort et al., 2023 + PDF定義表）
    if (weather === "Sunny") {
      const dT = tempC - avgTempC;
      envE += clamp(0.01 * dT, -0.1, 0.2);
      envV += clamp(0.01 * dT + 0.08, -0.05, 0.25);
      minBpm = Math.max(minBpm, 105);
      logs.push(`[天気: 晴れ] 気温偏差(ΔT=${dT}℃)適用`);
    } else if (weather === "Rain") {
      envV -= 0.1; envE -= 0.2;
      maxBpm = Math.min(maxBpm, 105);
      minAc = Math.max(minAc, 0.4);
      logs.push(`[天気: 雨] 鎮静・雨音調和 (V-0.1, E-0.2, BPM≦105)`);
    } else if (weather === "Snow") {
      envV -= 0.05; envE -= 0.2;
      maxBpm = Math.min(maxBpm, 95);
      minAc = Math.max(minAc, 0.5);
      logs.push(`[天気: 雪] 緊張緩和スローテンポ (BPM≦95, Ac≧0.5)`);
    }

    // 時間帯・季節・景色
    if (timeOfDay === "Morning") { envV += 0.2; envE += 0.2; minBpm = Math.max(minBpm, 105); }
    if (timeOfDay === "Evening") { envV += 0.1; envE -= 0.1; }
    if (timeOfDay === "Night") { envE -= 0.15; maxBpm = Math.min(maxBpm, 105); }
    if (timeOfDay === "LateNight") { envV -= 0.1; envE -= 0.3; maxBpm = Math.min(maxBpm, 90); minInst = Math.max(minInst, 0.4); }

    if (season === "Summer" && weather === "Sunny") { envV += 0.15; envE += 0.15; }
    if (season === "Autumn") { envE -= 0.1; }

    if (location === "Coast") { envV += 0.15; minBpm = Math.max(minBpm, 105); }
    if (location === "Mountain") { envE += 0.15; minBpm = Math.max(minBpm, 110); }
    if (location === "Field") { envE -= 0.15; minAc = Math.max(minAc, 0.5); }
    if (location === "Viewpoint") { envV += 0.2; envE += 0.15; }

    minV = clamp(minV + envV, 0.2, 1.0);
    maxV = clamp(maxV + envV, 0.2, 1.0);
    minE = clamp(minE + envE, 0.1, 0.9);
    maxE = clamp(maxE + envE, 0.1, 0.9);

    // 車速・狭路・悪天候の優先クランプ
    if (speedKph < 15) {
      minE = 0.2; maxE = 0.4; minBpm = 70; maxBpm = 100;
      logs.push(`[CAN: 渋滞] Valence First ➔ E:[0.2,0.4], BPM:[70,100]`);
    } else if (speedKph >= 80) {
      minE = Math.max(minE, 0.6); maxE = Math.max(maxE, 0.9);
      minV = Math.max(minV, 0.5); minBpm = Math.max(minBpm, 115);
      logs.push(`[CAN: 高速巡航] E≧0.6, BPM≧115`);
    }

    if (location === "Narrow" || weather === "HeavyRain") {
      maxE = Math.min(maxE, 0.4); maxBpm = Math.min(maxBpm, 90); minInst = 0.5;
      logs.push(`[認知負荷制御] 狭路/豪雨 ➔ E≦0.4, BPM≦90, インスト優先(Inst≧0.5)`);
    }

    if (isHardBraking) {
      maxE = Math.min(maxE, 0.4); minV = clamp(minV + 0.2, 0.4, 0.9); maxBpm = Math.min(maxBpm, 90);
      logs.push(`[イベント: 急ブレーキ] 鎮静ウィンドウへ移行 (E≦0.4, V+0.2)`);
    }

    // 最優先：DMS眠気検知（Arousal First）
    if (isDrowsy) {
      minV = 0.6; maxV = 1.0; minE = 0.8; maxE = 1.0; minBpm = 125; maxBpm = 200; minInst = 0; maxInst = 0.15;
      logs.push(`🚨 [最優先割り込み: DMS眠気] Arousal First ➔ E≧0.8, V≧0.6, BPM≧125, ボーカル確定`);
    }

    if (minV > maxV) minV = maxV;
    if (minE > maxE) minE = maxE;
    if (minBpm > maxBpm) minBpm = maxBpm;

    return {
      isoStrategy,
      twoTapBox,
      finalBox: { minV, maxV, minE, maxE },
      minBpm, maxBpm, minInst, maxInst, minAc, maxAc,
      logs,
    };
  }, [
    selectedWho, selectedMood, speedKph, drivingMinutes,
    weather, season, timeOfDay, location, tempC, avgTempC,
    isDrowsy, isHardBraking, learnedShiftV, learnedShiftE,
  ]);

  // 候補楽曲プール
  const playablePool = useMemo(() => {
    const withId = tracks.filter((t) => t.spotifyId.length > 5);
    return onlyPlayableTracks && withId.length > 0 ? withId : tracks;
  }, [tracks, onlyPlayableTracks]);

  const matchedTracks = useMemo(() => {
    const { finalBox, minBpm, maxBpm, minInst, maxInst } = middleLayer;
    return playablePool.filter(
      (t) =>
        t.valence >= finalBox.minV && t.valence <= finalBox.maxV &&
        t.energy >= finalBox.minE && t.energy <= finalBox.maxE &&
        t.bpm >= minBpm && t.bpm <= maxBpm &&
        t.instrumentalness >= minInst && t.instrumentalness <= maxInst
    );
  }, [playablePool, middleLayer]);

  // 次の曲を選出（直前と同じ曲を避ける）
  const pickNextTrack = (excludeId?: number) => {
    if (playablePool.length === 0) return;
    let pool = matchedTracks.filter((t) => t.id !== excludeId);
    if (pool.length === 0) {
      const cV = (middleLayer.finalBox.minV + middleLayer.finalBox.maxV) / 2;
      const cE = (middleLayer.finalBox.minE + middleLayer.finalBox.maxE) / 2;
      pool = [...playablePool]
        .filter((t) => t.id !== excludeId)
        .sort(
          (a, b) =>
            Math.hypot(a.valence - cV, a.energy - cE) -
            Math.hypot(b.valence - cV, b.energy - cE)
        )
        .slice(0, 5);
    }
    const chosen = pool[Math.floor(Math.random() * pool.length)] || playablePool[0];
    setCurrentTrack(chosen);
  };

  // ====================================================================
  // 拡張B：環境変化イベントの検知（走行中に天気・場所・時間帯が変わった時）
  // ====================================================================
  useEffect(() => {
    if (phase !== "running") return;
    const prev = prevEnvRef.current;
    if (prev.weather !== weather || prev.location !== location || prev.timeOfDay !== timeOfDay) {
      setEnvChangeBanner(
        `環境変化を検知（天気:${weather} / 場所:${location} / 時間:${timeOfDay}）。選曲基準を更新しました。次曲または評価後に新しい環境曲が再生されます。`
      );
      prevEnvRef.current = { weather, location, timeOfDay };
    }
  }, [weather, location, timeOfDay, phase]);

  // ====================================================================
  // 拡張A：緊急割り込みイベント（楽曲を即座に停止 ➔ 警告音＋音声案内）
  // ====================================================================
  const triggerEmergencyAlert = (reason: "drowsy" | "brake" | "lane") => {
    const labelMap = {
      drowsy: "眠気・疲労を検知しました。安全のため休憩を取るか、覚醒を促す楽曲へ切り替えます。",
      brake: "急ブレーキを検知しました。車間距離を確保し、落ち着いて運転してください。",
      lane: "車線逸脱を検知しました。前方に注意してください。",
    };

    // 1. 音楽停止フラグON（Spotify iframeを即座にアンマウント）
    setEmergencyActive(true);
    setEmergencyReason(labelMap[reason]);
    if (reason === "drowsy") setIsDrowsy(true);
    if (reason === "brake") setIsHardBraking(true);

    // 2. Web Audio API で警告ビープ音を鳴らす
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      [0, 0.25, 0.5].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(880, ctx.currentTime + offset);
        gain.gain.setValueAtTime(0.18, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.2);
      });
    } catch {
      // AudioContext非対応環境は無視
    }

    // 3. 音声合成で注意喚起アナウンス
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(labelMap[reason]);
      utter.lang = "ja-JP";
      utter.rate = 1.05;
      window.speechSynthesis.speak(utter);
    }
  };

  // 緊急状態解除 ➔ 安全運転/状況適応曲を再開
  const resolveEmergencyAndResume = () => {
    setEmergencyActive(false);
    setEmergencyReason("");
    setEnvChangeBanner(null);
    pickNextTrack(currentTrack?.id);
  };

  // ====================================================================
  // 実験開始（主シーケンス Step 2 ➔ 4）
  // ====================================================================
  const startExperiment = (mood: string) => {
    setSelectedMood(mood);
    const sid = `SES-${Date.now().toString(36).toUpperCase()}`;
    setSessionId(sid);
    setSavedCount(0);
    setLearnedShiftV(0);
    setLearnedShiftE(0);
    setEnvChangeBanner(null);
    setPhase("running");
    prevEnvRef.current = { weather, location, timeOfDay };
    // 初期選曲
    setTimeout(() => pickNextTrack(), 50);
  };

  // ====================================================================
  // 評価の記録（Supabaseへ自動保存 ➔ 次の曲を選曲）
  // ====================================================================
  const submitEvaluation = async (type: "no_discomfort" | "discomfort" | "skip") => {
    if (!currentTrack) return;

    const scoreMap = { no_discomfort: 1, discomfort: 0, skip: -1 };
    const eventType = isDrowsy || isHardBraking
      ? "Emergency_A"
      : envChangeBanner
      ? "EnvChange_B"
      : "Normal";

    const payload = {
      participant_id: participantId || "ANON",
      session_id: sessionId,
      who_selection: selectedWho,
      mood_selection: selectedMood,
      iso_strategy: middleLayer.isoStrategy,
      event_type: eventType,
      speed_kph: speedKph,
      weather,
      location,
      time_of_day: timeOfDay,
      season,
      is_drowsy: isDrowsy,
      is_hard_braking: isHardBraking,
      target_v_min: Number(middleLayer.finalBox.minV.toFixed(2)),
      target_v_max: Number(middleLayer.finalBox.maxV.toFixed(2)),
      target_e_min: Number(middleLayer.finalBox.minE.toFixed(2)),
      target_e_max: Number(middleLayer.finalBox.maxE.toFixed(2)),
      track_id: currentTrack.id,
      track_name: currentTrack.name,
      artist_name: currentTrack.artist,
      track_valence: currentTrack.valence,
      track_energy: currentTrack.energy,
      track_bpm: currentTrack.bpm,
      evaluation: type,
      evaluation_score: scoreMap[type],
      comment: evalComment.trim() || null,
    };

    // Supabaseへ送信
    if (supabase) {
      setDbStatus("保存中...");
      const { error } = await supabase.from("experiment_logs").insert([payload]);
      if (error) {
        console.error("Supabase保存エラー:", error);
        setDbStatus(`保存エラー: ${error.message}`);
      } else {
        setSavedCount((c) => c + 1);
        setDbStatus("DB保存成功");
      }
    } else {
      setSavedCount((c) => c + 1);
      setDbStatus("未接続(ローカル動作)");
    }

    // 簡易オンライン学習（閉ループ重み更新）
    if (type !== "skip") {
      const cV = (middleLayer.finalBox.minV + middleLayer.finalBox.maxV) / 2;
      const cE = (middleLayer.finalBox.minE + middleLayer.finalBox.maxE) / 2;
      const sign = type === "no_discomfort" ? 1 : -1;
      setLearnedShiftV((p) => clamp(p + sign * 0.04 * (currentTrack.valence - cV), -0.2, 0.2));
      setLearnedShiftE((p) => clamp(p + sign * 0.04 * (currentTrack.energy - cE), -0.2, 0.2));
    }

    setFeedbackToast(
      type === "no_discomfort"
        ? "「違和感がない」を記録し、次の曲を選曲しました"
        : type === "discomfort"
        ? "「違和感がある」を記録し、重みを調整して次の曲を選曲しました"
        : "スキップを記録し、現在のコンディションで再選曲しました"
    );
    setTimeout(() => setFeedbackToast(null), 3000);

    setEvalComment("");
    setEnvChangeBanner(null);
    pickNextTrack(currentTrack.id);
  };

  // 実験終了 ➔ 次の被験者待ちリセット
  const finishExperiment = () => {
    setEmergencyActive(false);
    setCurrentTrack(null);
    setPhase("finished");
  };

  const resetForNextParticipant = () => {
    setParticipantId("");
    setSetupStep(1);
    setIsDrowsy(false);
    setIsHardBraking(false);
    setEmergencyActive(false);
    setSpeedKph(50);
    setWeather("Sunny");
    setLocation("Normal");
    setTimeOfDay("Day");
    setPhase("setup");
  };

  const playableTrackCount = tracks.filter((t) => t.spotifyId.length > 5).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6 font-sans">
      {/* ヘッダー */}
      <header className="max-w-6xl mx-auto flex flex-wrap justify-between items-center border-b border-slate-800 pb-4 mb-6 gap-3">
        <div className="flex items-center gap-3">
          <Car className="w-7 h-7 text-cyan-400" />
          <div>
            <h1 className="text-lg md:text-xl font-bold text-white">
              状況適応型車載BGMシステム 評価実験アプリ
            </h1>
            <p className="text-xs text-slate-400">
              DB読込: 全{tracks.length}曲（うちSpotify直接再生対応: {playableTrackCount}曲）
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border ${
              supabase
                ? "bg-emerald-950/60 border-emerald-700 text-emerald-300"
                : "bg-amber-950/60 border-amber-700 text-amber-300"
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            {supabase ? `Supabase接続済 (${savedCount}件保存 / ${dbStatus})` : "Supabase未設定(.env.local確認)"}
          </span>

          {phase === "running" && (
            <>
              <button
                onClick={() => setShowControlPanel((v) => !v)}
                className="flex items-center gap-1 bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg border border-slate-700"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                実験者パネル{showControlPanel ? "隠す" : "表示"}
              </button>
              <button
                onClick={finishExperiment}
                className="flex items-center gap-1 bg-rose-700 hover:bg-rose-600 text-white font-bold px-3 py-1.5 rounded-lg"
              >
                <StopCircle className="w-3.5 h-3.5" /> 実験終了
              </button>
            </>
          )}
        </div>
      </header>

      {/* ====================================================================
          PHASE 1: 被験者セットアップ画面（手順書 1〜2）
         ==================================================================== */}
      {phase === "setup" && (
        <div className="max-w-2xl mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-6 md:p-8 space-y-6">
          <div className="text-xs font-bold tracking-widest text-cyan-400 uppercase">
            STEP {setupStep} / 3 : 実験開始セットアップ
          </div>

          {setupStep === 1 && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold">被験者IDを入力してください</h2>
              <p className="text-sm text-slate-400">
                実験データと紐づけるための識別子です（例：P01、Aさん など）。
              </p>
              <input
                type="text"
                value={participantId}
                onChange={(e) => setParticipantId(e.target.value)}
                placeholder="例: P01"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl p-4 text-lg focus:outline-none focus:border-cyan-400"
              />
              <button
                onClick={() => setSetupStep(2)}
                disabled={!participantId.trim()}
                className="w-full bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold py-4 rounded-xl transition flex items-center justify-center gap-2"
              >
                <Play className="w-5 h-5" /> 次へ進む（同乗者選択）
              </button>
            </div>
          )}

          {setupStep === 2 && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold">誰と乗っている想定ですか？（Who）</h2>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { id: "Solo", label: "ひとり (Solo)", desc: "自由度高・自分向け" },
                  { id: "Partner", label: "パートナー (2人)", desc: "落ち着いた共有空間" },
                  { id: "Friends", label: "友人 (2〜3人)", desc: "明るく盛り上がる曲中心" },
                  { id: "Group", label: "グループ・家族", desc: "幅広い聴きやすい選曲" },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setSelectedWho(item.id);
                      setSetupStep(3);
                    }}
                    className="p-5 rounded-xl bg-slate-950 hover:bg-cyan-950 border border-slate-700 hover:border-cyan-400 text-left transition"
                  >
                    <div className="font-bold text-lg">{item.label}</div>
                    <div className="text-xs text-slate-400 mt-1">{item.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {setupStep === 3 && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold">現在の気分を選んでください（Mood）</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {[
                  { id: "Chill", label: "☕ リラックス (Chill)" },
                  { id: "Energy", label: "🔥 盛り上がり (Energy)" },
                  { id: "Awake", label: "⚡ シャキッと (Awake)" },
                  { id: "Excited", label: "✨ ワクワク (Excited)" },
                  { id: "Night", label: "🌙 しっとり (Night)" },
                  { id: "Mix", label: "🎲 おまかせ (MIX)" },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => startExperiment(item.id)}
                    className="p-5 rounded-xl bg-slate-950 hover:bg-cyan-950 border border-slate-700 hover:border-cyan-400 text-left font-bold transition"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ====================================================================
          PHASE 2: 実験実行画面（被験者評価UI ＋ 実験者コンディション操作盤）
         ==================================================================== */}
      {phase === "running" && (
        <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* 左側：被験者向けプレイヤー＆評価画面 */}
          <div className={showControlPanel ? "lg:col-span-7 space-y-5" : "lg:col-span-12 max-w-3xl mx-auto w-full space-y-5"}>
            {/* 拡張A：緊急イベント割り込みオーバーレイ */}
            {emergencyActive && (
              <div className="bg-rose-950 border-2 border-rose-500 rounded-2xl p-6 space-y-4 animate-pulse">
                <div className="flex items-center gap-3 text-rose-300">
                  <ShieldAlert className="w-10 h-10 shrink-0" />
                  <div>
                    <div className="text-xs font-bold uppercase tracking-widest">
                      拡張A：緊急安全割り込み発動（楽曲再生を一時停止中）
                    </div>
                    <h2 className="text-xl font-bold text-white mt-1">{emergencyReason}</h2>
                  </div>
                </div>
                <button
                  onClick={resolveEmergencyAndResume}
                  className="w-full bg-white text-rose-950 font-extrabold py-3 rounded-xl hover:bg-rose-100 transition"
                >
                  危険状態を解除し、安全適応楽曲の再生を再開する
                </button>
              </div>
            )}

            {/* 拡張B：環境変化通知バナー */}
            {envChangeBanner && !emergencyActive && (
              <div className="bg-amber-950/70 border border-amber-600 rounded-xl p-4 flex items-center justify-between gap-3 text-sm text-amber-200">
                <span>🔔 {envChangeBanner}</span>
                <button
                  onClick={() => {
                    setEnvChangeBanner(null);
                    pickNextTrack(currentTrack?.id);
                  }}
                  className="shrink-0 bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold text-xs px-3 py-1.5 rounded-lg"
                >
                  今すぐ新環境の曲へ切替
                </button>
              </div>
            )}

            {/* トースト通知 */}
            {feedbackToast && (
              <div className="bg-cyan-950 border border-cyan-500 text-cyan-200 text-sm px-4 py-3 rounded-xl">
                ✅ {feedbackToast}
              </div>
            )}

            {/* 楽曲再生カード（Spotify埋め込みプレイヤー） */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div className="flex flex-wrap justify-between items-center gap-2 text-xs text-slate-400">
                <span>
                  被験者: <b className="text-white">{participantId}</b> / 初期設定: {selectedWho} × {selectedMood}
                </span>
                <span className="bg-cyan-950 text-cyan-300 px-2.5 py-1 rounded border border-cyan-800 font-mono">
                  ISO戦略: {middleLayer.isoStrategy}
                </span>
              </div>

              {currentTrack && !emergencyActive ? (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                      <Music className="w-6 h-6 text-cyan-400" />
                      {currentTrack.name}
                    </h2>
                    <p className="text-slate-400">{currentTrack.artist}</p>
                    <p className="text-xs font-mono text-cyan-400 mt-1">
                      V:{currentTrack.valence} / E:{currentTrack.energy} / BPM:{currentTrack.bpm} / Inst:{currentTrack.instrumentalness}
                    </p>
                  </div>

                  {/* Spotify Embed プレイヤー */}
                  {currentTrack.spotifyId ? (
                    <iframe
                      key={currentTrack.spotifyId}
                      src={`https://open.spotify.com/embed/track/${currentTrack.spotifyId}?utm_source=generator&theme=0`}
                      width="100%"
                      height="152"
                      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                      loading="lazy"
                      className="rounded-xl border border-slate-800"
                    />
                  ) : (
                    <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row justify-between items-center gap-3">
                      <span className="text-xs text-slate-400">
                        ※この曲はCSVにSpotify_IDが未登録です。外部プレイヤーで開くかIDを追加してください。
                      </span>
                      <a
                        href={`https://open.spotify.com/search/${encodeURIComponent(
                          `${currentTrack.artist} ${currentTrack.name}`
                        )}`}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-4 py-2 rounded-lg"
                      >
                        Spotifyで再生を開く
                      </a>
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-36 flex items-center justify-center text-slate-500 bg-slate-950 rounded-xl border border-slate-800">
                  {emergencyActive ? "緊急警告のため再生停止中" : "選曲中..."}
                </div>
              )}

              {/* 被験者評価セクション（手順書 Step 7〜9） */}
              <div className="border-t border-slate-800 pt-5 space-y-4">
                <div className="text-sm font-bold text-slate-200">
                  現在の走行状況に対して、この曲の雰囲気はどう感じますか？
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    onClick={() => submitEvaluation("no_discomfort")}
                    disabled={emergencyActive}
                    className="flex items-center justify-center gap-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-bold py-4 rounded-xl text-base shadow-lg transition active:scale-95"
                  >
                    <ThumbsUp className="w-5 h-5" /> 違和感がない（合っている）
                  </button>
                  <button
                    onClick={() => submitEvaluation("discomfort")}
                    disabled={emergencyActive}
                    className="flex items-center justify-center gap-2 bg-rose-700 hover:bg-rose-600 disabled:opacity-40 text-white font-bold py-4 rounded-xl text-base shadow-lg transition active:scale-95"
                  >
                    <ThumbsDown className="w-5 h-5" /> 違和感がある（合っていない）
                  </button>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={evalComment}
                    onChange={(e) => setEvalComment(e.target.value)}
                    placeholder="気づいた点があれば任意でメモ（例：テンポが速すぎる等）"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-cyan-500"
                  />
                  <button
                    onClick={() => submitEvaluation("skip")}
                    disabled={emergencyActive}
                    className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-bold px-4 py-2 rounded-xl border border-slate-700"
                  >
                    <SkipForward className="w-4 h-4" /> スキップ
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 右側：実験実施者用 コンディション＆イベント操作パネル */}
          {showControlPanel && (
            <div className="lg:col-span-5 space-y-5">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-bold text-cyan-400 flex items-center gap-1.5">
                    <Activity className="w-4 h-4" /> 実験者用：走行コンディション操作
                  </h3>
                  <label className="text-[11px] text-slate-400 flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={onlyPlayableTracks}
                      onChange={(e) => setOnlyPlayableTracks(e.target.checked)}
                    />
                    ID登録済のみ選曲
                  </label>
                </div>

                {/* 車速・走行時間 */}
                <div className="space-y-3 bg-slate-950 p-3.5 rounded-xl border border-slate-800 text-xs">
                  <div>
                    <div className="flex justify-between mb-1">
                      <span>車速 (CAN)</span>
                      <span className="font-mono text-cyan-400 font-bold">
                        {speedKph} km/h ({speedKph < 15 ? "渋滞" : speedKph >= 80 ? "高速" : "一般道"})
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={130}
                      value={speedKph}
                      onChange={(e) => setSpeedKph(Number(e.target.value))}
                      className="w-full accent-cyan-400"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span>連続走行時間</span>
                      <span className="font-mono text-amber-400 font-bold">{drivingMinutes} 分</span>
                    </div>
                    <input
                      type="range"
                      min={5}
                      max={120}
                      step={5}
                      value={drivingMinutes}
                      onChange={(e) => setDrivingMinutes(Number(e.target.value))}
                      className="w-full accent-amber-400"
                    />
                  </div>
                </div>

                {/* 外部環境（拡張Bトリガー） */}
                <div className="grid grid-cols-2 gap-2.5 text-xs">
                  <div>
                    <label className="text-slate-400 flex items-center gap-1 mb-1">
                      <CloudRain className="w-3.5 h-3.5" /> 天気
                    </label>
                    <select
                      value={weather}
                      onChange={(e) => setWeather(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2"
                    >
                      <option value="Sunny">☀️ 晴れ</option>
                      <option value="Cloudy">☁️ 曇り</option>
                      <option value="Rain">🌧️ 雨</option>
                      <option value="HeavyRain">⛈️ 豪雨/雷雨</option>
                      <option value="Snow">❄️ 雪</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-slate-400 flex items-center gap-1 mb-1">
                      <Compass className="w-3.5 h-3.5" /> 景色・道路
                    </label>
                    <select
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2"
                    >
                      <option value="Normal">🏙️ 市街地</option>
                      <option value="Coast">🏖️ 海辺</option>
                      <option value="Mountain">⛰️ 山道</option>
                      <option value="Field">🌾 野原</option>
                      <option value="Narrow">⚠️ 細道</option>
                      <option value="Viewpoint">🌉 見晴らし良</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-slate-400 flex items-center gap-1 mb-1">
                      <Clock className="w-3.5 h-3.5" /> 時間帯
                    </label>
                    <select
                      value={timeOfDay}
                      onChange={(e) => setTimeOfDay(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2"
                    >
                      <option value="Morning">🌅 朝</option>
                      <option value="Day">☀️ 昼</option>
                      <option value="Evening">🌇 夕方</option>
                      <option value="Night">🌃 夜</option>
                      <option value="LateNight">🌌 深夜</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-slate-400 mb-1 block">🍂 季節 / 気温({tempC}℃)</label>
                    <select
                      value={season}
                      onChange={(e) => {
                        setSeason(e.target.value);
                        setTempC(e.target.value === "Summer" ? 32 : e.target.value === "Winter" ? 4 : 20);
                      }}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2"
                    >
                      <option value="Spring">春</option>
                      <option value="Summer">夏</option>
                      <option value="Autumn">秋</option>
                      <option value="Winter">冬</option>
                    </select>
                  </div>
                </div>

                {/* 拡張A：緊急割り込み発火ボタン群 */}
                <div className="border-t border-slate-800 pt-3 space-y-2">
                  <div className="text-xs font-bold text-rose-400 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> 拡張A：緊急割り込みトリガー（音楽即停止＋警告音）
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <button
                      onClick={() => triggerEmergencyAlert("drowsy")}
                      className="bg-rose-950 hover:bg-rose-900 border border-rose-700 text-rose-200 font-bold py-2 rounded-lg"
                    >
                      🚨 眠気検知
                    </button>
                    <button
                      onClick={() => triggerEmergencyAlert("brake")}
                      className="bg-amber-950 hover:bg-amber-900 border border-amber-700 text-amber-200 font-bold py-2 rounded-lg"
                    >
                      ⚡ 急ブレーキ
                    </button>
                    <button
                      onClick={() => triggerEmergencyAlert("lane")}
                      className="bg-orange-950 hover:bg-orange-900 border border-orange-700 text-orange-200 font-bold py-2 rounded-lg"
                    >
                      🚧 車線逸脱
                    </button>
                  </div>
                  {(isDrowsy || isHardBraking) && (
                    <button
                      onClick={() => {
                        setIsDrowsy(false);
                        setIsHardBraking(false);
                      }}
                      className="w-full text-[11px] text-slate-400 hover:text-white underline pt-1"
                    >
                      眠気・急ブレーキ補正フラグを通常へ戻す
                    </button>
                  )}
                </div>
              </div>

              {/* 中間処理トレース */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
                <div className="text-xs font-bold text-cyan-400 flex items-center gap-1">
                  <Zap className="w-3.5 h-3.5" /> 中間処理トレース（算出範囲）
                </div>
                <div className="bg-slate-950 p-3 rounded-xl font-mono text-[11px] text-slate-300 space-y-1 max-h-40 overflow-y-auto">
                  {middleLayer.logs.map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                </div>
                <div className="text-[11px] font-mono text-cyan-300 flex justify-between pt-1">
                  <span>V: [{middleLayer.finalBox.minV.toFixed(2)}, {middleLayer.finalBox.maxV.toFixed(2)}]</span>
                  <span>E: [{middleLayer.finalBox.minE.toFixed(2)}, {middleLayer.finalBox.maxE.toFixed(2)}]</span>
                  <span>BPM: {middleLayer.minBpm}〜{middleLayer.maxBpm}</span>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {/* ====================================================================
          PHASE 3: 実験終了画面（手順書 事後条件：次被験者待機へ）
         ==================================================================== */}
      {phase === "finished" && (
        <div className="max-w-lg mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-5">
          <CheckCircle2 className="w-16 h-16 text-emerald-400 mx-auto" />
          <h2 className="text-2xl font-bold">実験終了</h2>
          <p className="text-sm text-slate-300">
            被験者 <b>{participantId}</b> の評価データ（計 <b>{savedCount}</b> 件）の記録が完了しました。楽曲再生を停止しています。
          </p>
          <button
            onClick={resetForNextParticipant}
            className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-3.5 rounded-xl transition"
          >
            次の被験者の実験準備へ進む
          </button>
        </div>
      )}
    </div>
  );
}