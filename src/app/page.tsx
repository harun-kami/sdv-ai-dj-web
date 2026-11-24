"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "@/lib/supabase";
import {
  Car,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  SkipForward,
  SkipBack,
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
  MapPin,
  RefreshCw,
} from "lucide-react";

// ==========================================
// 型定義（C# SongTrack 準拠）
// ==========================================
interface SongTrack {
  trackId: number;
  trackName: string;
  artistName: string;
  valence: number;
  energy: number;
  bpm: number;
  instrumentalness: number;
  vibe: string;
  acousticness: number;
  spotifyId: string;
  trackUri: string;
  evaluation: number; // 0: 未評価, 1: 違和感なし(Match), 2: 違和感あり(Discomfort)
}

type ExperimentPhase = "setup" | "running" | "finished";
type PlayMode = "order" | "adaptive";

const clamp = (val: number, min: number, max: number) =>
  Math.min(Math.max(val, min), max);

const WHO_LABELS: Record<string, string> = {
  BtnWhoSolo: "ひとり (Solo)",
  BtnWhoPartner: "パートナー (2人きり)",
  BtnWhoFriends: "友人 (2〜3人)",
  BtnWhoGroup: "グループ・家族 (4人〜 / 子連れ)",
};

const MOOD_LABELS: Record<string, string> = {
  BtnMoodChill: "リラックス (Chill)",
  BtnMoodRefresh: "気分転換・爽快 (Refresh)",
  BtnMoodParty: "盛り上がり (Party)",
  BtnMoodFocus: "集中・眠気覚まし (Focus)",
  BtnMoodEmotional: "エモい・浸りたい (Emotional)",
  BtnMoodMix: "おまかせ (Auto / MIX)",
};

export default function SdvExperimentApp() {
  // 楽曲DB ＆ 再生状態（C#と同じく Track_ID 順管理 + URIキャッシュ）
  const [tracks, setTracks] = useState<SongTrack[]>([]);
  const tracksRef = useRef<SongTrack[]>([]);
  const [currentTrackIdx, setCurrentTrackIdx] = useState<number>(0);
  const [isChangingTrack, setIsChangingTrack] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>("待機中...");
  const [playMode, setPlayMode] = useState<PlayMode>("order"); // デフォルト：C#と同じTrack_ID順再生

  // 実験フェーズ＆被験者情報
  const [phase, setPhase] = useState<ExperimentPhase>("setup");
  const [participantId, setParticipantId] = useState<string>("P001");
  const [sessionId, setSessionId] = useState<string>("");
  const [setupStep, setSetupStep] = useState<1 | 2 | 3>(1);

  // 2タップ入力（C#のボタン名と完全一致）
  const [selectedWho, setSelectedWho] = useState<string>("BtnWhoSolo");
  const [selectedMood, setSelectedMood] = useState<string>("BtnMoodChill");

  // 車両・環境コンテキスト（GPS & Open-Meteo 自動取得 + 実験者手動オーバーライド）
  const [showControlPanel, setShowControlPanel] = useState<boolean>(true);
  const [speedKph, setSpeedKph] = useState<number>(50);
  const [engineRpm, setEngineRpm] = useState<number>(2000);
  const [drivingMinutes, setDrivingMinutes] = useState<number>(15);
  const [weather, setWeather] = useState<string>("Sunny");
  const [displayWeatherStr, setDisplayWeatherStr] = useState<string>("取得中...");
  const [displayLocationStr, setDisplayLocationStr] = useState<string>("位置取得中...");
  const [season, setSeason] = useState<string>("Autumn");
  const [timeOfDay, setTimeOfDay] = useState<string>("Day");
  const [location, setLocation] = useState<string>("Normal");

  // 拡張A（緊急割り込み）＆ 拡張B（環境変化通知）
  const [emergencyActive, setEmergencyActive] = useState<boolean>(false);
  const [emergencyReason, setEmergencyReason] = useState<string>("");
  const [isDrowsy, setIsDrowsy] = useState<boolean>(false);
  const [isHardBraking, setIsHardBraking] = useState<boolean>(false);
  const [envChangeBanner, setEnvChangeBanner] = useState<string | null>(null);

  // DB保存状態＆メモ
  const [dbStatus, setDbStatus] = useState<string>("待機中");
  const [savedCount, setSavedCount] = useState<number>(0);
  const [evalComment, setEvalComment] = useState<string>("");

  const prevEnvRef = useRef({ weather, location, timeOfDay });

  // tracksステートの最新値をrefにも同期
  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  // ====================================================================
  // 1. public/sdv_music_db.csv 読み込み（C# LoadMusicCsv 移植）
  // ====================================================================
  useEffect(() => {
    fetch("/sdv_music_db.csv")
      .then((res) => res.text())
      .then((csvText) => {
        const lines = csvText.trim().split(/\r?\n/).slice(1);
        const parsed: SongTrack[] = lines
          .map((line) => {
            if (!line.trim()) return null;
            const p = line.split(",");
            if (p.length < 8) return null;
            const trackId = parseInt(p[0].trim(), 10);
            if (isNaN(trackId)) return null;

            const col7 = p[7].trim().replace(/^"|"$/g, "");
            const numericCol7 = parseFloat(col7);
            const isNumericCol7 = !isNaN(numericCol7);

            return {
              trackId,
              trackName: p[1].trim().replace(/^"|"$/g, ""),
              artistName: p[2].trim().replace(/^"|"$/g, ""),
              valence: parseFloat(p[3].trim()) || 0.5,
              energy: parseFloat(p[4].trim()) || 0.5,
              bpm: parseFloat(p[5].trim()) || 100,
              instrumentalness: parseFloat(p[6].trim()) || 0,
              vibe: isNumericCol7 ? "" : col7,
              acousticness: isNumericCol7 ? numericCol7 : 0,
              spotifyId: (p[8] || "").trim(),
              trackUri: (p[8] || "").trim() ? `spotify:track:${(p[8] || "").trim()}` : "",
              evaluation: 0,
            };
          })
          .filter((t): t is SongTrack => t !== null)
          .sort((a, b) => a.trackId - b.trackId);

        setTracks(parsed);
        tracksRef.current = parsed;
      })
      .catch((err) => console.error("CSV読込エラー:", err));
  }, []);

  // ====================================================================
  // 2. GPS + Open-Meteo 天気自動取得（C# FetchAndUpdateWeatherContextAsync 移植）
  // ====================================================================
  const fetchWeatherAndLocation = async () => {
    setDisplayLocationStr("位置取得中...");
    setDisplayWeatherStr("天気取得中...");

    // デフォルト座標（C#と同じ福岡の座標）
    let latitude = 33.5902;
    let longitude = 130.4017;

    if (typeof window !== "undefined" && "geolocation" in navigator) {
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 60000,
          })
        );
        latitude = pos.coords.latitude;
        longitude = pos.coords.longitude;
      } catch {
        // 位置情報未許可・タイムアウト時は福岡デフォルトを使用
      }
    }

    setDisplayLocationStr(`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=weather_code,temperature_2m,precipitation&timezone=Asia%2FTokyo`;
      const res = await fetch(url);
      if (!res.ok) {
        setDisplayWeatherStr(`API拒否 (${res.status})`);
        return;
      }
      const data = await res.json();
      const current = data.current;
      const weatherCode: number = current.weather_code ?? current.weathercode ?? 0;
      const temperature: number = current.temperature_2m ?? 20;
      const precipitation: number = current.precipitation ?? 0;

      // C# ApplyWeatherMusicControl と完全一致する判定ロジック
      if (weatherCode === 71 || weatherCode === 73 || weatherCode === 75) {
        setWeather("Snow");
        setDisplayWeatherStr(`${temperature.toFixed(1)}°C (雪)`);
      } else if ((weatherCode >= 51 && weatherCode <= 67) || precipitation > 0) {
        setWeather("Rain");
        setDisplayWeatherStr(`${temperature.toFixed(1)}°C (雨)`);
      } else if (weatherCode === 0 || weatherCode === 1) {
        setWeather("Sunny");
        setDisplayWeatherStr(`${temperature.toFixed(1)}°C (晴れ)`);
      } else {
        setWeather("Cloudy");
        setDisplayWeatherStr(`${temperature.toFixed(1)}°C (曇り/その他)`);
      }
    } catch {
      setDisplayWeatherStr("天気取得エラー");
    }
  };

  useEffect(() => {
    fetchWeatherAndLocation();
  }, []);

  // ====================================================================
  // 3. 2タップUI ＆ コンテキスト演算（C# BtnWho_Click / BtnMood_Click 移植）
  // ====================================================================
  const targetParams = useMemo(() => {
    const logs: string[] = [];

    // 1タップ目 (Who) ベースレンジ（C#と完全同一）
    let baseMinV = 0.2, baseMaxV = 1.0, baseMinE = 0.1, baseMaxE = 0.9;
    switch (selectedWho) {
      case "BtnWhoSolo":
        baseMinV = 0.2; baseMaxV = 1.0; baseMinE = 0.1; baseMaxE = 0.9; break;
      case "BtnWhoPartner":
        baseMinV = 0.3; baseMaxV = 0.7; baseMinE = 0.2; baseMaxE = 0.7; break;
      case "BtnWhoFriends":
        baseMinV = 0.5; baseMaxV = 1.0; baseMinE = 0.5; baseMaxE = 0.9; break;
      case "BtnWhoGroup":
        baseMinV = 0.3; baseMaxV = 0.8; baseMinE = 0.2; baseMaxE = 0.6; break;
    }

    // 2タップ目 (Mood) シフト計算（C#と完全同一）
    let finalMinV = 0.2, finalMaxV = 1.0, finalMinE = 0.1, finalMaxE = 0.9;
    if (selectedMood !== "BtnMoodMix") {
      let shiftV = 0.0, shiftE = 0.0;
      switch (selectedMood) {
        case "BtnMoodChill":     shiftV = +0.0;  shiftE = -0.25; break;
        case "BtnMoodRefresh":   shiftV = +0.2;  shiftE = +0.15; break;
        case "BtnMoodParty":     shiftV = +0.3;  shiftE = +0.35; break;
        case "BtnMoodFocus":     shiftV = +0.0;  shiftE = +0.35; break;
        case "BtnMoodEmotional": shiftV = -0.15; shiftE = -0.15; break;
      }
      finalMinV = clamp(baseMinV + shiftV, 0.1, 1.0);
      finalMaxV = clamp(baseMaxV + shiftV, 0.2, 1.0);
      finalMinE = clamp(baseMinE + shiftE, 0.1, 1.0);
      finalMaxE = clamp(baseMaxE + shiftE, 0.2, 1.0);
    }

    logs.push(
      `[2タップ基準] ${WHO_LABELS[selectedWho]} × ${MOOD_LABELS[selectedMood]} ➔ V:[${finalMinV.toFixed(2)}, ${finalMaxV.toFixed(2)}] E:[${finalMinE.toFixed(2)}, ${finalMaxE.toFixed(2)}]`
    );

    // ISO遷移戦略タグ
    let isoStrategy = "Linear";
    if (isDrowsy) {
      isoStrategy = "Arousal First";
      finalMinV = 0.6; finalMaxV = 1.0; finalMinE = 0.8; finalMaxE = 1.0;
      logs.push("🚨 [DMS眠気検知] Arousal First ➔ E≧0.8, V≧0.6 に強制固定");
    } else if (speedKph < 15 || isHardBraking) {
      isoStrategy = "Valence First";
      finalMinE = 0.2; finalMaxE = 0.4;
      logs.push("[渋滞/急ブレーキ] Valence First ➔ E:[0.20, 0.40] に鎮静化");
    } else if (drivingMinutes >= 60) {
      isoStrategy = "Dynamic";
      logs.push("[長距離走行] Dynamic ➔ 揺らぎモード");
    }

    if (playMode === "order") {
      logs.push("[再生モード] C#準拠：CSVのTrack_ID順で順番に再生中");
    } else {
      logs.push("[再生モード] 状況適応：算出レンジに最も近い曲を自動抽出");
    }

    return {
      minV: finalMinV,
      maxV: finalMaxV,
      minE: finalMinE,
      maxE: finalMaxE,
      isoStrategy,
      logs,
    };
  }, [selectedWho, selectedMood, speedKph, drivingMinutes, isDrowsy, isHardBraking, playMode]);

  // ====================================================================
  // 4. Spotify Track ID 自動検索＋キャッシュ＋再生準備（C# PlayNextInOrderTrack 移植）
  // ====================================================================
  const loadAndPlayTrackAtIndex = async (targetIdx: number) => {
    const list = tracksRef.current;
    if (list.length === 0 || isChangingTrack) return;

    setIsChangingTrack(true);
    const normalizedIdx = ((targetIdx % list.length) + list.length) % list.length;
    const selected = list[normalizedIdx];

    setCurrentTrackIdx(normalizedIdx);
    setStatusMessage(`[ID:${selected.trackId}] 再生準備中... ${selected.trackName}`);

    try {
      // 初回再生時にサーバーAPI経由でSpotify IDを自動検索してメモリキャッシュ（CSVへのID手入力不要）
      if (!selected.spotifyId) {
        const res = await fetch(
          `/api/spotify-search?track=${encodeURIComponent(selected.trackName)}&artist=${encodeURIComponent(selected.artistName)}`
        );
        if (res.ok) {
          const data = await res.json();
          if (data.found && data.spotifyId) {
            const updatedList = [...tracksRef.current];
            updatedList[normalizedIdx] = {
              ...updatedList[normalizedIdx],
              spotifyId: data.spotifyId,
              trackUri: data.uri || `spotify:track:${data.spotifyId}`,
            };
            tracksRef.current = updatedList;
            setTracks(updatedList);
          }
        }
      }

      const readyTrack = tracksRef.current[normalizedIdx];
      if (readyTrack.spotifyId) {
        setStatusMessage(
          `[${normalizedIdx + 1}/${list.length}曲${readyTrack.vibe ? ` | ${readyTrack.vibe}` : ""}] 再生準備完了: ${readyTrack.artistName} - ${readyTrack.trackName}`
        );
      } else {
        setStatusMessage(`エラー: ${readyTrack.trackName} がSpotifyで見つかりませんでした`);
      }
    } catch (err) {
      console.error(err);
      setStatusMessage("Spotify検索エラー（環境変数を確認してください）");
    } finally {
      // C#と同じく0.4秒の連打防止クールタイム
      setTimeout(() => setIsChangingTrack(false), 400);
    }
  };

  // 次の曲のインデックスを決める（Track_ID順 or 状況適応）
  const resolveNextIndex = (fromIdx: number): number => {
    const list = tracksRef.current;
    if (list.length === 0) return 0;

    if (playMode === "order") {
      return (fromIdx + 1) % list.length;
    }

    // 状況適応モード：ターゲット中心に最も近い未再生寄りの候補から選択
    const cV = (targetParams.minV + targetParams.maxV) / 2;
    const cE = (targetParams.minE + targetParams.maxE) / 2;
    const candidates = list
      .map((t, idx) => ({ t, idx, dist: Math.hypot(t.valence - cV, t.energy - cE) }))
      .filter((x) => x.idx !== fromIdx)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8);

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return pick ? pick.idx : (fromIdx + 1) % list.length;
  };

  // ====================================================================
  // 5. Supabase ログ保存（C# AppendEvalLog 移植）
  // ====================================================================
  const saveLogToSupabase = async (
    track: SongTrack,
    eventType: "EVAL" | "SKIP" | "PREV_FROM" | "PREV_TO",
    note: string
  ) => {
    const evalLabel =
      eventType === "EVAL"
        ? track.evaluation === 1
          ? "no_discomfort"
          : "discomfort"
        : eventType.toLowerCase();

    const payload = {
      participant_id: participantId.trim() || "P001",
      session_id: sessionId,
      who_selection: WHO_LABELS[selectedWho] || selectedWho,
      mood_selection: MOOD_LABELS[selectedMood] || selectedMood,
      iso_strategy: targetParams.isoStrategy,
      event_type: eventType,
      speed_kph: speedKph,
      weather: displayWeatherStr || weather,
      location: `${location} (${displayLocationStr})`,
      time_of_day: timeOfDay,
      season,
      is_drowsy: isDrowsy,
      is_hard_braking: isHardBraking,
      target_v_min: Number(targetParams.minV.toFixed(2)),
      target_v_max: Number(targetParams.maxV.toFixed(2)),
      target_e_min: Number(targetParams.minE.toFixed(2)),
      target_e_max: Number(targetParams.maxE.toFixed(2)),
      track_id: track.trackId,
      track_name: track.trackName,
      artist_name: track.artistName,
      track_valence: track.valence,
      track_energy: track.energy,
      track_bpm: Math.round(track.bpm),
      evaluation: evalLabel,
      evaluation_score: track.evaluation, // C#準拠：0=未評価, 1=マッチ, 2=いまいち
      comment: [note, evalComment.trim()].filter(Boolean).join(" / ") || null,
    };

    if (!supabase) {
      setSavedCount((c) => c + 1);
      setDbStatus("未接続(ローカル動作)");
      return;
    }

    setDbStatus("保存中...");
    const { error } = await supabase.from("experiment_logs").insert([payload]);
    if (error) {
      console.error("Supabase保存エラー:", error);
      setDbStatus(`保存エラー: ${error.message}`);
    } else {
      setSavedCount((c) => c + 1);
      setDbStatus("DB保存成功");
    }
  };

  // ====================================================================
  // 6. 評価ボタン（C# BtnEval_Click：パターンA ➔ 曲は進めない！）
  // ====================================================================
  const handleEvalClick = async (evalValue: 1 | 2) => {
    const current = tracksRef.current[currentTrackIdx];
    if (!current) return;

    const updatedList = [...tracksRef.current];
    updatedList[currentTrackIdx] = { ...current, evaluation: evalValue };
    tracksRef.current = updatedList;
    setTracks(updatedList);

    const evalText = evalValue === 1 ? "👍 違和感なし (Match)" : "👎 違和感あり (Bad)";
    setStatusMessage(`【評価完了】 ${evalText} と記録しました (値: ${evalValue}) ※曲は継続再生`);

    await saveLogToSupabase(
      updatedList[currentTrackIdx],
      "EVAL",
      evalValue === 1 ? "Match" : "Bad"
    );
    setEvalComment("");
  };

  // ====================================================================
  // 7. 次の曲（スキップ）（C# BtnNextTrack_Click 移植）
  // ====================================================================
  const handleNextTrackClick = async () => {
    if (isChangingTrack || tracksRef.current.length === 0) return;

    const current = tracksRef.current[currentTrackIdx];
    if (current) {
      await saveLogToSupabase(
        current,
        "SKIP",
        current.evaluation === 0 ? "UnratedSkip" : "RatedSkip"
      );
    }

    setEnvChangeBanner(null);
    const nextIdx = resolveNextIndex(currentTrackIdx);
    await loadAndPlayTrackAtIndex(nextIdx);
  };

  // ====================================================================
  // 8. 前の曲へ戻る（C# BtnPrevTrack_Click：評価を0にリセットする機能付き）
  // ====================================================================
  const handlePrevTrackClick = async () => {
    const list = tracksRef.current;
    if (isChangingTrack || list.length === 0) return;

    const prevIdx = (currentTrackIdx - 1 + list.length) % list.length;

    // 1. 戻る元（今流れていた曲）を PREV_FROM として記録
    const fromTrack = list[currentTrackIdx];
    await saveLogToSupabase(fromTrack, "PREV_FROM", "MovedToPrev");

    // 2. 戻る先（1つ前の曲）の評価を 0 にリセットし、PREV_TO として記録
    const updatedList = [...list];
    updatedList[prevIdx] = { ...updatedList[prevIdx], evaluation: 0 };
    tracksRef.current = updatedList;
    setTracks(updatedList);

    await saveLogToSupabase(updatedList[prevIdx], "PREV_TO", "EvaluationResetTo0");
    setStatusMessage("前の曲に戻ります（評価を 0 にリセットしました）");

    await loadAndPlayTrackAtIndex(prevIdx);
  };

  // ====================================================================
  // 拡張B：環境変化の検知
  // ====================================================================
  useEffect(() => {
    if (phase !== "running") return;
    const prev = prevEnvRef.current;
    if (prev.weather !== weather || prev.location !== location || prev.timeOfDay !== timeOfDay) {
      setEnvChangeBanner(
        `環境変化を検知（天気:${weather} / 場所:${location} / 時間:${timeOfDay}）。次曲から反映できます。`
      );
      prevEnvRef.current = { weather, location, timeOfDay };
    }
  }, [weather, location, timeOfDay, phase]);

  // ====================================================================
  // 拡張A：緊急割り込み（即座停止＋警告音＋音声案内）
  // ====================================================================
  const triggerEmergencyAlert = (reason: "drowsy" | "brake" | "lane") => {
    const labelMap = {
      drowsy: "眠気・疲労を検知しました。安全のため休憩を取るか、覚醒を促す楽曲へ切り替えます。",
      brake: "急ブレーキを検知しました。車間距離を確保し、落ち着いて運転してください。",
      lane: "車線逸脱を検知しました。前方に注意してください。",
    };

    setEmergencyActive(true);
    setEmergencyReason(labelMap[reason]);
    if (reason === "drowsy") setIsDrowsy(true);
    if (reason === "brake") setIsHardBraking(true);

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
      // ignore
    }

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(labelMap[reason]);
      utter.lang = "ja-JP";
      utter.rate = 1.05;
      window.speechSynthesis.speak(utter);
    }
  };

  const resolveEmergencyAndResume = () => {
    setEmergencyActive(false);
    setEmergencyReason("");
    setEnvChangeBanner(null);
    loadAndPlayTrackAtIndex(resolveNextIndex(currentTrackIdx));
  };

  // ====================================================================
  // 実験開始 / 終了 / リセット
  // ====================================================================
  const startExperiment = (moodKey: string) => {
    setSelectedMood(moodKey);
    const now = new Date();
    const sid = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate()
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
      now.getMinutes()
    ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    setSessionId(sid);
    setSavedCount(0);
    setEnvChangeBanner(null);

    // 評価状態をすべて0に初期化してID順の先頭(0)から開始
    const resetTracks = tracksRef.current.map((t) => ({ ...t, evaluation: 0 }));
    tracksRef.current = resetTracks;
    setTracks(resetTracks);

    setPhase("running");
    prevEnvRef.current = { weather, location, timeOfDay };
    setTimeout(() => loadAndPlayTrackAtIndex(0), 50);
  };

  const finishExperiment = () => {
    setEmergencyActive(false);
    setPhase("finished");
  };

  const resetForNextParticipant = () => {
    setSetupStep(1);
    setIsDrowsy(false);
    setIsHardBraking(false);
    setEmergencyActive(false);
    setSpeedKph(50);
    setPhase("setup");
  };

  const currentTrack = tracks[currentTrackIdx] || null;

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
              DB読込: 全{tracks.length}曲 | 天気: {displayWeatherStr} | 位置: {displayLocationStr}
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
            {supabase ? `Supabase接続済 (${savedCount}件 / ${dbStatus})` : "Supabase未設定"}
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
          PHASE 1: 被験者セットアップ画面（C# 2タップUI完全準拠）
         ==================================================================== */}
      {phase === "setup" && (
        <div className="max-w-2xl mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-6 md:p-8 space-y-6">
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold tracking-widest text-cyan-400 uppercase">
              STEP {setupStep} / 3 : 実験開始セットアップ
            </span>
            {setupStep > 1 && (
              <button
                onClick={() => setSetupStep((s) => (s === 3 ? 2 : 1))}
                className="text-xs text-slate-400 hover:text-white underline"
              >
                ← ひとつ前に戻る
              </button>
            )}
          </div>

          {setupStep === 1 && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold">被験者IDを入力してください</h2>
              <p className="text-sm text-slate-400">
                実験データと紐づける識別子です（例：P001、P002 など）。
              </p>
              <input
                type="text"
                value={participantId}
                onChange={(e) => setParticipantId(e.target.value)}
                placeholder="例: P001"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl p-4 text-lg focus:outline-none focus:border-cyan-400"
              />
              <button
                onClick={() => setSetupStep(2)}
                disabled={!participantId.trim()}
                className="w-full bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold py-4 rounded-xl transition flex items-center justify-center gap-2"
              >
                <Play className="w-5 h-5" /> 次へ進む（同乗者の構成を選択）
              </button>
            </div>
          )}

          {setupStep === 2 && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold">同乗者の構成を選択（Who）</h2>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { id: "BtnWhoSolo", label: "ひとり (Solo)", desc: "V:0.2~1.0 / E:0.1~0.9" },
                  { id: "BtnWhoPartner", label: "パートナー (2人きり)", desc: "V:0.3~0.7 / E:0.2~0.7" },
                  { id: "BtnWhoFriends", label: "友人 (2〜3人)", desc: "V:0.5~1.0 / E:0.5~0.9" },
                  { id: "BtnWhoGroup", label: "グループ・家族", desc: "V:0.3~0.8 / E:0.2~0.6" },
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
                    <div className="text-xs text-slate-400 font-mono mt-1">{item.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {setupStep === 3 && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold">現在の気分を選択（Mood）</h2>
              <p className="text-xs text-cyan-400">
                選択中 : {WHO_LABELS[selectedWho]} ➔ 気分を選択して実験を開始します
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {[
                  { id: "BtnMoodChill", label: "☕ リラックス (Chill)", sub: "V+0.0 / E-0.25" },
                  { id: "BtnMoodRefresh", label: "🍃 気分転換・爽快 (Refresh)", sub: "V+0.2 / E+0.15" },
                  { id: "BtnMoodParty", label: "🔥 盛り上がり (Party)", sub: "V+0.3 / E+0.35" },
                  { id: "BtnMoodFocus", label: "⚡ 集中・眠気覚まし (Focus)", sub: "V+0.0 / E+0.35" },
                  { id: "BtnMoodEmotional", label: "🌙 エモい・浸りたい (Emotional)", sub: "V-0.15 / E-0.15" },
                  { id: "BtnMoodMix", label: "🎲 おまかせ (Auto / MIX)", sub: "全範囲開放" },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => startExperiment(item.id)}
                    className="p-4 rounded-xl bg-slate-950 hover:bg-cyan-950 border border-slate-700 hover:border-cyan-400 text-left transition"
                  >
                    <div className="font-bold text-sm">{item.label}</div>
                    <div className="text-[11px] text-slate-400 font-mono mt-1">{item.sub}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ====================================================================
          PHASE 2: 実験実行画面
         ==================================================================== */}
      {phase === "running" && (
        <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* 左側：被験者向けプレイヤー＆評価画面 */}
          <div
            className={
              showControlPanel
                ? "lg:col-span-7 space-y-5"
                : "lg:col-span-12 max-w-3xl mx-auto w-full space-y-5"
            }
          >
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
                  危険状態を解除し、楽曲再生を再開する
                </button>
              </div>
            )}

            {/* 拡張B：環境変化通知バナー */}
            {envChangeBanner && !emergencyActive && (
              <div className="bg-amber-950/70 border border-amber-600 rounded-xl p-4 flex items-center justify-between gap-3 text-sm text-amber-200">
                <span>🔔 {envChangeBanner}</span>
                <button
                  onClick={handleNextTrackClick}
                  className="shrink-0 bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold text-xs px-3 py-1.5 rounded-lg"
                >
                  次の曲へ切替
                </button>
              </div>
            )}

            {/* ステータスバー（C# TxtStatus 相当） */}
            <div className="bg-slate-900 border border-cyan-900/60 text-cyan-200 text-xs font-mono px-4 py-2.5 rounded-xl flex justify-between items-center gap-2">
              <span>{statusMessage}</span>
              <span className="text-slate-400 shrink-0">
                現在評価:{" "}
                {currentTrack?.evaluation === 1
                  ? "👍 1 (違和感なし)"
                  : currentTrack?.evaluation === 2
                  ? "👎 2 (違和感あり)"
                  : "0 (未評価)"}
              </span>
            </div>

            {/* 楽曲再生カード（Spotify自動検索 Embed プレイヤー） */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div className="flex flex-wrap justify-between items-center gap-2 text-xs text-slate-400">
                <span>
                  被験者: <b className="text-white">{participantId}</b> |{" "}
                  {WHO_LABELS[selectedWho]} × {MOOD_LABELS[selectedMood]}
                </span>
                <span className="bg-cyan-950 text-cyan-300 px-2.5 py-1 rounded border border-cyan-800 font-mono">
                  {currentTrackIdx + 1} / {tracks.length}曲 ({playMode === "order" ? "ID順" : "状況適応"})
                </span>
              </div>

              {currentTrack && !emergencyActive ? (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                      <Music className="w-6 h-6 text-cyan-400 shrink-0" />
                      {currentTrack.trackName}
                    </h2>
                    <p className="text-slate-400">{currentTrack.artistName}</p>
                    <p className="text-xs font-mono text-cyan-400 mt-1">
                      ID:{currentTrack.trackId} | V:{currentTrack.valence} | E:{currentTrack.energy} | BPM:{currentTrack.bpm} | Inst:{currentTrack.instrumentalness}
                    </p>
                  </div>

                  {/* 自動検索した Spotify Track ID で埋め込みプレイヤーを描画 */}
                  {isChangingTrack ? (
                    <div className="h-[152px] flex items-center justify-center bg-slate-950 rounded-xl border border-slate-800 text-sm text-cyan-400">
                      Spotifyから楽曲を検索中...
                    </div>
                  ) : currentTrack.spotifyId ? (
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
                        ※Spotify API自動検索で見つからないか、SPOTIFY_CLIENT_ID / SECRET が未設定です。
                      </span>
                      <a
                        href={`https://open.spotify.com/search/${encodeURIComponent(
                          `${currentTrack.trackName} ${currentTrack.artistName}`
                        )}`}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-4 py-2 rounded-lg"
                      >
                        Spotifyで検索を開く
                      </a>
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-36 flex items-center justify-center text-slate-500 bg-slate-950 rounded-xl border border-slate-800">
                  {emergencyActive ? "緊急警告のため再生停止中" : "選曲中..."}
                </div>
              )}

              {/* 評価セクション（C#パターンA：押しても曲は進めない） */}
              <div className="border-t border-slate-800 pt-5 space-y-4">
                <div className="flex justify-between items-center text-sm">
                  <span className="font-bold text-slate-200">
                    この曲の評価（押しても曲は止まらず継続再生されます）
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    onClick={() => handleEvalClick(1)}
                    disabled={emergencyActive || isChangingTrack}
                    className={`flex items-center justify-center gap-2 font-bold py-4 rounded-xl text-base shadow-lg transition active:scale-95 disabled:opacity-40 ${
                      currentTrack?.evaluation === 1
                        ? "bg-cyan-500 ring-2 ring-white text-slate-950"
                        : "bg-cyan-700 hover:bg-cyan-600 text-white"
                    }`}
                  >
                    <ThumbsUp className="w-5 h-5" /> 違和感がない / マッチ (1)
                  </button>
                  <button
                    onClick={() => handleEvalClick(2)}
                    disabled={emergencyActive || isChangingTrack}
                    className={`flex items-center justify-center gap-2 font-bold py-4 rounded-xl text-base shadow-lg transition active:scale-95 disabled:opacity-40 ${
                      currentTrack?.evaluation === 2
                        ? "bg-rose-500 ring-2 ring-white text-white"
                        : "bg-rose-800 hover:bg-rose-700 text-white"
                    }`}
                  >
                    <ThumbsDown className="w-5 h-5" /> 違和感がある / いまいち (2)
                  </button>
                </div>

                {/* 任意メモ ＆ 前の曲・次の曲ボタン（C# BtnPrevTrack / BtnNextTrack 移植） */}
                <input
                  type="text"
                  value={evalComment}
                  onChange={(e) => setEvalComment(e.target.value)}
                  placeholder="気づいた点があれば任意でメモ（評価・スキップ時に一緒に保存）"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-cyan-500"
                />

                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={handlePrevTrackClick}
                    disabled={emergencyActive || isChangingTrack}
                    className="flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-sm font-bold py-3 rounded-xl border border-slate-700"
                  >
                    <SkipBack className="w-4 h-4" /> 前の曲へ戻る（評価リセット）
                  </button>
                  <button
                    onClick={handleNextTrackClick}
                    disabled={emergencyActive || isChangingTrack}
                    className="flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-sm font-bold py-3 rounded-xl border border-slate-600"
                  >
                    次の曲へ（スキップ） <SkipForward className="w-4 h-4" />
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
                  <button
                    onClick={fetchWeatherAndLocation}
                    className="flex items-center gap-1 text-[11px] bg-slate-800 hover:bg-slate-700 px-2.5 py-1 rounded-lg border border-slate-700"
                  >
                    <RefreshCw className="w-3 h-3" /> GPS/天気再取得
                  </button>
                </div>

                {/* 再生モード切替（C#準拠ID順 vs 状況適応） */}
                <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800 text-xs">
                  <button
                    onClick={() => setPlayMode("order")}
                    className={`py-2 rounded-lg font-bold transition ${
                      playMode === "order"
                        ? "bg-cyan-600 text-white"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    CSV Track_ID順（C#準拠）
                  </button>
                  <button
                    onClick={() => setPlayMode("adaptive")}
                    className={`py-2 rounded-lg font-bold transition ${
                      playMode === "adaptive"
                        ? "bg-cyan-600 text-white"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    状況適応選曲（V/E一致）
                  </button>
                </div>

                {/* 車速・RPM・連続走行時間 */}
                <div className="space-y-3 bg-slate-950 p-3.5 rounded-xl border border-slate-800 text-xs">
                  <div>
                    <div className="flex justify-between mb-1">
                      <span>車速 (CAN 0x20)</span>
                      <span className="font-mono text-cyan-400 font-bold">
                        {speedKph} km/h ({speedKph < 15 ? "渋滞" : speedKph >= 80 ? "高速" : "一般道"})
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={140}
                      value={speedKph}
                      onChange={(e) => setSpeedKph(Number(e.target.value))}
                      className="w-full accent-cyan-400"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span>エンジン回転数 (CAN 0x30)</span>
                      <span className="font-mono text-slate-200 font-bold">{engineRpm} RPM</span>
                    </div>
                    <input
                      type="range"
                      min={800}
                      max={7000}
                      step={100}
                      value={engineRpm}
                      onChange={(e) => setEngineRpm(Number(e.target.value))}
                      className="w-full accent-slate-300"
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

                {/* 外部環境（GPS自動取得値＋手動変更可能） */}
                <div className="text-[11px] text-slate-400 flex items-center gap-1.5 bg-slate-950 px-3 py-2 rounded-lg border border-slate-800">
                  <MapPin className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span>実測: {displayWeatherStr} / 座標: {displayLocationStr}</span>
                </div>

                <div className="grid grid-cols-2 gap-2.5 text-xs">
                  <div>
                    <label className="text-slate-400 flex items-center gap-1 mb-1">
                      <CloudRain className="w-3.5 h-3.5" /> 天気
                    </label>
                    <select
                      value={weather}
                      onChange={(e) => {
                        setWeather(e.target.value);
                        setDisplayWeatherStr(e.target.value);
                      }}
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
                    <label className="text-slate-400 mb-1 block">🍂 季節</label>
                    <select
                      value={season}
                      onChange={(e) => setSeason(e.target.value)}
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
                  <Zap className="w-3.5 h-3.5" /> パラメータ算出トレース
                </div>
                <div className="bg-slate-950 p-3 rounded-xl font-mono text-[11px] text-slate-300 space-y-1 max-h-40 overflow-y-auto">
                  {targetParams.logs.map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                </div>
                <div className="text-[11px] font-mono text-cyan-300 flex justify-between pt-1">
                  <span>Valence: {targetParams.minV.toFixed(2)} ~ {targetParams.maxV.toFixed(2)}</span>
                  <span>Energy: {targetParams.minE.toFixed(2)} ~ {targetParams.maxE.toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {/* ====================================================================
          PHASE 3: 実験終了画面
         ==================================================================== */}
      {phase === "finished" && (
        <div className="max-w-lg mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-5">
          <CheckCircle2 className="w-16 h-16 text-emerald-400 mx-auto" />
          <h2 className="text-2xl font-bold">実験終了</h2>
          <p className="text-sm text-slate-300">
            被験者 <b>{participantId}</b> のログ（計 <b>{savedCount}</b> 件）を保存しました。
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