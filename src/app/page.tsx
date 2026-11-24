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
// 型定義
// ==========================================
interface SongTrack {
  trackId: number;
  trackName: string;
  artistName: string;
  valence: number;
  energy: number;
  bpm: number;
  instrumentalness: number;
  acousticness: number;
  vibe: string;
  spotifyId: string;
  trackUri: string;
  evaluation: number; // 0: 未評価, 1: 違和感なし(Match), 2: 違和感あり(Discomfort)
}

type ExperimentPhase = "setup" | "running" | "finished";
type PlayMode = "adaptive" | "order";
type IsoStrategy = "Arousal First" | "Valence First" | "Linear" | "Dynamic";

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

// 月ごとの基準平均気温（気温偏差モデル用）
const SEASON_AVG_TEMP: Record<string, number> = {
  Spring: 16,
  Summer: 27,
  Autumn: 18,
  Winter: 7,
};

export default function SdvExperimentApp() {
  // 楽曲DB ＆ 再生状態
  const [tracks, setTracks] = useState<SongTrack[]>([]);
  const tracksRef = useRef<SongTrack[]>([]);
  const [currentTrackIdx, setCurrentTrackIdx] = useState<number>(0);
  const [historyIndices, setHistoryIndices] = useState<number[]>([]);
  const [playedIds, setPlayedIds] = useState<number[]>([]);
  const [dynamicPhaseStep, setDynamicPhaseStep] = useState<number>(0); // 60分超の揺らぎ位相
  const [isChangingTrack, setIsChangingTrack] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>("待機中...");
  const [playMode, setPlayMode] = useState<PlayMode>("adaptive"); // デフォルト：イベント・シーン一覧表フル版

  // 実験フェーズ＆被験者情報
  const [phase, setPhase] = useState<ExperimentPhase>("setup");
  const [participantId, setParticipantId] = useState<string>("P001");
  const [sessionId, setSessionId] = useState<string>("");
  const [setupStep, setSetupStep] = useState<1 | 2 | 3>(1);

  // 2タップ入力（C#ボタン名準拠）
  const [selectedWho, setSelectedWho] = useState<string>("BtnWhoSolo");
  const [selectedMood, setSelectedMood] = useState<string>("BtnMoodChill");

  // 車両・環境コンテキスト（GPS & Open-Meteo 自動取得 + 実験者手動操作）
  const [showControlPanel, setShowControlPanel] = useState<boolean>(true);
  const [speedKph, setSpeedKph] = useState<number>(50);
  const [engineRpm, setEngineRpm] = useState<number>(2000);
  const [drivingMinutes, setDrivingMinutes] = useState<number>(15);
  const [weather, setWeather] = useState<string>("Sunny");
  const [tempC, setTempC] = useState<number>(20);
  const [sunshineScore, setSunshineScore] = useState<number>(0.8);
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

  // 閉ループ学習オフセット（評価1/2によるセッション内重み更新）
  const [learnedShiftV, setLearnedShiftV] = useState<number>(0);
  const [learnedShiftE, setLearnedShiftE] = useState<number>(0);

  // DB保存状態＆メモ
  const [dbStatus, setDbStatus] = useState<string>("待機中");
  const [savedCount, setSavedCount] = useState<number>(0);
  const [evalComment, setEvalComment] = useState<string>("");

  const prevEnvRef = useRef({ weather, location, timeOfDay, season });

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  // ====================================================================
  // 1. public/sdv_music_db.csv 読み込み
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
              acousticness: isNumericCol7 ? numericCol7 : 0.2,
              vibe: isNumericCol7 ? "" : col7,
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
  // 2. GPS + Open-Meteo 天気・気温・時間帯・季節 自動取得
  // ====================================================================
  const fetchWeatherAndLocation = async () => {
    setDisplayLocationStr("位置取得中...");
    setDisplayWeatherStr("天気取得中...");

    // 現在時刻から時間帯・季節を自動初期設定
    const now = new Date();
    const hour = now.getHours();
    if (hour >= 5 && hour < 10) setTimeOfDay("Morning");
    else if (hour >= 10 && hour < 16) setTimeOfDay("Day");
    else if (hour >= 16 && hour < 18) setTimeOfDay("Evening");
    else if (hour >= 18 && hour < 22) setTimeOfDay("Night");
    else setTimeOfDay("LateNight");

    const month = now.getMonth() + 1;
    if (month >= 3 && month <= 5) setSeason("Spring");
    else if (month >= 6 && month <= 8) setSeason("Summer");
    else if (month >= 9 && month <= 11) setSeason("Autumn");
    else setSeason("Winter");

    // デフォルト座標（福岡）
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
        // 位置情報未許可時は福岡デフォルト
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

      setTempC(Math.round(temperature));

      if (weatherCode === 71 || weatherCode === 73 || weatherCode === 75) {
        setWeather("Snow");
        setSunshineScore(0.1);
        setDisplayWeatherStr(`${temperature.toFixed(1)}°C (雪)`);
      } else if (weatherCode >= 95 || precipitation >= 10) {
        setWeather("HeavyRain");
        setSunshineScore(0.0);
        setDisplayWeatherStr(`${temperature.toFixed(1)}°C (豪雨/雷雨)`);
      } else if ((weatherCode >= 51 && weatherCode <= 67) || precipitation > 0) {
        setWeather("Rain");
        setSunshineScore(0.1);
        setDisplayWeatherStr(`${temperature.toFixed(1)}°C (雨)`);
      } else if (weatherCode === 0 || weatherCode === 1) {
        setWeather("Sunny");
        setSunshineScore(0.9);
        setDisplayWeatherStr(`${temperature.toFixed(1)}°C (晴れ)`);
      } else {
        setWeather("Cloudy");
        setSunshineScore(0.5);
        setDisplayWeatherStr(`${temperature.toFixed(1)}°C (曇り)`);
      }
    } catch {
      setDisplayWeatherStr("天気取得エラー");
    }
  };

  useEffect(() => {
    fetchWeatherAndLocation();
  }, []);

  // ====================================================================
  // 3. ★ イベント・シーン一覧表 フル版 中間処理エンジン
  // ====================================================================
  const engineResult = useMemo(() => {
    const logs: string[] = [];

    // ----------------------------------------------------
    // Step 1: 2タップUI ベースレンジ決定（C#完全準拠）
    // ----------------------------------------------------
    let baseMinV = 0.2, baseMaxV = 1.0, baseMinE = 0.1, baseMaxE = 0.9;
    switch (selectedWho) {
      case "BtnWhoSolo":    baseMinV = 0.2; baseMaxV = 1.0; baseMinE = 0.1; baseMaxE = 0.9; break;
      case "BtnWhoPartner": baseMinV = 0.3; baseMaxV = 0.7; baseMinE = 0.2; baseMaxE = 0.7; break;
      case "BtnWhoFriends": baseMinV = 0.5; baseMaxV = 1.0; baseMinE = 0.5; baseMaxE = 0.9; break;
      case "BtnWhoGroup":   baseMinV = 0.3; baseMaxV = 0.8; baseMinE = 0.2; baseMaxE = 0.6; break;
    }

    let minV = 0.2, maxV = 1.0, minE = 0.1, maxE = 0.9;
    if (selectedMood === "BtnMoodMix") {
      logs.push(`[1. 2タップ基準] ${WHO_LABELS[selectedWho]} × MIX ➔ 全開放レンジ`);
    } else {
      let shiftV = 0.0, shiftE = 0.0;
      switch (selectedMood) {
        case "BtnMoodChill":     shiftV = +0.0;  shiftE = -0.25; break;
        case "BtnMoodRefresh":   shiftV = +0.2;  shiftE = +0.15; break;
        case "BtnMoodParty":     shiftV = +0.3;  shiftE = +0.35; break;
        case "BtnMoodFocus":     shiftV = +0.0;  shiftE = +0.35; break;
        case "BtnMoodEmotional": shiftV = -0.15; shiftE = -0.15; break;
      }
      minV = clamp(baseMinV + shiftV, 0.1, 1.0);
      maxV = clamp(baseMaxV + shiftV, 0.2, 1.0);
      minE = clamp(baseMinE + shiftE, 0.1, 1.0);
      maxE = clamp(baseMaxE + shiftE, 0.2, 1.0);
      logs.push(
        `[1. 2タップ基準] ${WHO_LABELS[selectedWho]} × ${MOOD_LABELS[selectedMood]} ➔ V:[${minV.toFixed(2)},${maxV.toFixed(2)}] E:[${minE.toFixed(2)},${maxE.toFixed(2)}]`
      );
    }

    const twoTapBox = { minV, maxV, minE, maxE };

    // 5次元目標パラメータ初期値
    let minBpm = 60, maxBpm = 200;
    let minInst = 0.0, maxInst = 1.0;
    let minAc = 0.0, maxAc = 1.0;
    let volumeNote = "100% (標準)";

    // ISO原理の遷移戦略決定
    let isoStrategy: IsoStrategy = "Linear";
    if (isDrowsy) {
      isoStrategy = "Arousal First";
    } else if (speedKph < 15 || isHardBraking) {
      isoStrategy = "Valence First";
    } else if (drivingMinutes >= 60) {
      isoStrategy = "Dynamic";
    }
    logs.push(`[2. ISO遷移戦略] ${isoStrategy}`);

    // ----------------------------------------------------
    // Step 2: 環境シフト（天気・季節・時間帯・景色）
    // ----------------------------------------------------
    let envV = 0.0, envE = 0.0;
    const avgTemp = SEASON_AVG_TEMP[season] ?? 18;
    const dTemp = tempC - avgTemp;

    // 天気（一覧表 + 気温偏差モデル）
    if (weather === "Sunny") {
      const kE = 0.012, kV = 0.012, wS = 0.1;
      const dE = clamp(kE * dTemp, -0.1, 0.2);
      const dV = clamp(kV * dTemp + wS * sunshineScore, -0.05, 0.25);
      envE += dE;
      envV += dV;
      minBpm = Math.max(minBpm, 105);
      maxBpm = Math.min(maxBpm, 130);
      maxInst = Math.min(maxInst, 0.3);
      logs.push(
        `[3. 天気: 晴れ] 気温偏差(ΔT=${dTemp >= 0 ? "+" : ""}${dTemp}℃, 日照=${sunshineScore}) ➔ ΔV:${dV >= 0 ? "+" : ""}${dV.toFixed(2)}, ΔE:${dE >= 0 ? "+" : ""}${dE.toFixed(2)}, BPM[105,130], Inst<0.3`
      );
    } else if (weather === "Cloudy") {
      envV -= 0.05; envE -= 0.1;
      minBpm = Math.max(minBpm, 80); maxBpm = Math.min(maxBpm, 110);
      logs.push(`[3. 天気: 曇り] やや落ち着いたトーン ➔ V-0.05, E-0.10, BPM[80,110]`);
    } else if (weather === "Rain") {
      envV -= 0.1; envE -= 0.2;
      minBpm = Math.max(minBpm, 75); maxBpm = Math.min(maxBpm, 105);
      minAc = Math.max(minAc, 0.4);
      logs.push(`[3. 天気: 雨] 鎮静・雨音調和 ➔ V-0.10, E-0.20, BPM[75,105], Ac≧0.4`);
    } else if (weather === "Snow") {
      envV -= 0.05; envE -= 0.2;
      minBpm = Math.max(minBpm, 65); maxBpm = Math.min(maxBpm, 95);
      minAc = Math.max(minAc, 0.5);
      logs.push(`[3. 天気: 雪] スリップ緊張緩和 ➔ V-0.05, E-0.20, BPM[65,95], Ac≧0.5`);
    }

    // 季節（3-5春 / 6-8夏 / 9-11秋 / 12-2冬）
    if (season === "Summer" && weather === "Sunny") {
      envV += 0.2; envE += 0.2;
      minBpm = Math.max(minBpm, 115); maxBpm = Math.max(maxBpm, 135);
      logs.push(`[4. 季節: 夏×晴れ] 外向性ピーク補正 ➔ V+0.20, E+0.20, BPM[115,135]`);
    } else if (season === "Spring") {
      envV += 0.1; envE += 0.05;
      logs.push(`[4. 季節: 春] 爽やか補正 ➔ V+0.10, E+0.05`);
    } else if (season === "Autumn") {
      envE -= 0.1;
      logs.push(`[4. 季節: 秋] 落ち着き補正 ➔ Vフラット, E-0.10`);
    } else if (season === "Winter") {
      envV -= 0.1; envE -= 0.3;
      minBpm = Math.min(minBpm, 65); maxBpm = Math.min(maxBpm, 95);
      minAc = Math.max(minAc, 0.5);
      logs.push(`[4. 季節: 冬] 温かみスロー補正 ➔ V-0.10, E-0.30, BPM[65,95], Ac≧0.5`);
    }

    // 時間帯（朝5-10 / 昼10-16 / 夕方16-18 / 夜18-22 / 深夜22-5）
    if (timeOfDay === "Morning") {
      envV += 0.2; envE += 0.2;
      minBpm = Math.max(minBpm, 105); maxBpm = Math.max(maxBpm, 125);
      maxInst = Math.min(maxInst, 0.3);
      logs.push(`[5. 時間帯: 朝] 目覚め・爽快促進 ➔ V+0.20, E+0.20, BPM[105,125], Inst<0.3`);
    } else if (timeOfDay === "Day") {
      logs.push(`[5. 時間帯: 昼] 2タップ設定を最優先 (補正なし)`);
    } else if (timeOfDay === "Evening") {
      envV -= 0.1; envE -= 0.1;
      minBpm = Math.min(minBpm, 80); maxBpm = Math.min(maxBpm, 105);
      logs.push(`[5. 時間帯: 夕方] 夕暮れ疲労考慮 ➔ V-0.10, E-0.10, BPM[80,105]`);
    } else if (timeOfDay === "Night") {
      envE -= 0.15;
      minBpm = Math.min(minBpm, 80); maxBpm = Math.min(maxBpm, 105);
      minAc = Math.max(minAc, 0.2); maxAc = Math.min(maxAc, 0.7);
      logs.push(`[5. 時間帯: 夜] リラックス寄り ➔ Vフラット, E-0.15, BPM[80,105], Ac[0.2,0.7]`);
    } else if (timeOfDay === "LateNight") {
      envV -= 0.1; envE -= 0.35;
      minBpm = Math.min(minBpm, 65); maxBpm = Math.min(maxBpm, 90);
      minInst = Math.max(minInst, 0.4);
      logs.push(`[5. 時間帯: 深夜] 低エネルギー・チル固定 ➔ V-0.10, E-0.35, BPM[65,90], Inst≧0.4`);
    }

    // 閉ループ学習オフセットの加算
    if (learnedShiftV !== 0 || learnedShiftE !== 0) {
      envV += learnedShiftV;
      envE += learnedShiftE;
      logs.push(
        `[閉ループ重み] 評価履歴オフセット ➔ ΔV:${learnedShiftV >= 0 ? "+" : ""}${learnedShiftV.toFixed(2)}, ΔE:${learnedShiftE >= 0 ? "+" : ""}${learnedShiftE.toFixed(2)}`
      );
    }

    // シフト適用
    minV = clamp(minV + envV, 0.1, 1.0);
    maxV = clamp(maxV + envV, 0.2, 1.0);
    minE = clamp(minE + envE, 0.1, 1.0);
    maxE = clamp(maxE + envE, 0.2, 1.0);

    // 景色・道路（一覧表の目標領域へブレンド統合）
    if (location === "Coast") {
      minV = (minV + 0.6) / 2; maxV = (maxV + 0.9) / 2;
      minE = (minE + 0.5) / 2; maxE = (maxE + 0.7) / 2;
      minBpm = Math.max(minBpm, 105); maxBpm = Math.max(maxBpm, 125);
      maxAc = Math.min(maxAc, 0.6);
      logs.push(`[6. 景色: 海辺] 開放感 ➔ V[0.6,0.9]・E[0.5,0.7]寄り, BPM[105,125]`);
    } else if (location === "Mountain") {
      minV = (minV + 0.5) / 2; maxV = (maxV + 0.8) / 2;
      minE = (minE + 0.6) / 2; maxE = (maxE + 0.8) / 2;
      minBpm = Math.max(minBpm, 110); maxBpm = Math.max(maxBpm, 130);
      logs.push(`[6. 景色: 山道] ワインディング同調 ➔ V[0.5,0.8]・E[0.6,0.8]寄り, BPM[110,130]`);
    } else if (location === "Field") {
      minV = (minV + 0.5) / 2; maxV = (maxV + 0.7) / 2;
      minE = (minE + 0.3) / 2; maxE = (maxE + 0.5) / 2;
      minBpm = Math.min(minBpm, 80); maxBpm = Math.min(maxBpm, 105);
      minAc = Math.max(minAc, 0.4);
      logs.push(`[6. 景色: 野原] のどかな調和 ➔ V[0.5,0.7]・E[0.3,0.5]寄り, Ac≧0.4`);
    } else if (location === "Viewpoint") {
      minV = (minV + 0.7) / 2; maxV = (maxV + 1.0) / 2;
      minE = (minE + 0.6) / 2; maxE = (maxE + 0.8) / 2;
      minBpm = Math.max(minBpm, 110); maxBpm = Math.max(maxBpm, 135);
      logs.push(`[6. 景色: 見晴らし良] 爽快感・ドラマチック ➔ V[0.7,1.0]・E[0.6,0.8]寄り, BPM[110,135]`);
    }

    // 長距離走行タイマー (>60分): 許容レンジ幅を ±0.15 で周期的に揺らす
    if (drivingMinutes >= 60) {
      const wave = Math.sin((dynamicPhaseStep * Math.PI) / 2) * 0.15;
      minV = clamp(minV + wave - 0.08, 0.1, 0.9);
      maxV = clamp(maxV + wave + 0.08, 0.2, 1.0);
      minE = clamp(minE - wave - 0.05, 0.1, 0.9);
      maxE = clamp(maxE - wave + 0.05, 0.2, 1.0);
      logs.push(
        `[7. 長距離タイマー (≧60分)] Dynamic揺らぎ適用 (位相:${dynamicPhaseStep}, 揺らぎ:${wave >= 0 ? "+" : ""}${wave.toFixed(2)})`
      );
    }

    // ----------------------------------------------------
    // Step 3: 車載CAN（渋滞/高速）＆ 安全・認知負荷の優先クランプ
    // ----------------------------------------------------
    if (speedKph < 15) {
      minE = 0.2; maxE = 0.4;
      minBpm = 70; maxBpm = 100;
      minAc = Math.max(minAc, 0.4);
      logs.push(`[8. CAN: 渋滞 (<15km/h)] 焦燥感緩和 ➔ E:[0.20,0.40], BPM[70,100], Ac≧0.4`);
    } else if (speedKph >= 80) {
      minE = Math.max(minE, 0.6); maxE = Math.max(maxE, 0.9);
      minV = Math.max(minV, 0.5); maxV = Math.max(maxV, 0.8);
      minBpm = Math.max(minBpm, 115); maxBpm = Math.max(maxBpm, 140);
      maxInst = Math.min(maxInst, 0.2);
      logs.push(`[8. CAN: 高速巡航 (≧80km/h)] 生体リズム同調 ➔ E:[0.60,0.90], V:[0.50,0.80], BPM[115,140], Inst<0.2`);
    }

    // 細道・狭路（認知負荷軽減 ★重要）
    if (location === "Narrow") {
      minE = 0.1; maxE = Math.min(maxE, 0.4);
      minBpm = 60; maxBpm = Math.min(maxBpm, 95);
      minInst = 0.5; maxInst = 1.0;
      logs.push(`[9. 安全制御: 細道] 認知負荷軽減 ➔ E:[0.10,0.40], BPM≦95, Inst≧0.5(ボーカル抑制)`);
    }

    // 豪雨・雷雨（視界不良時の集中最優先）
    if (weather === "HeavyRain") {
      minV = clamp(minV, 0.3, 0.6); maxV = clamp(maxV, 0.35, 0.6);
      minE = 0.1; maxE = Math.min(maxE, 0.4);
      minBpm = 60; maxBpm = Math.min(maxBpm, 90);
      minInst = 0.5; maxInst = 1.0;
      volumeNote = "80% (-20% 自動減衰)";
      logs.push(`[10. 悪天候制御: 豪雨/雷雨] 集中最優先 ➔ V:[0.3,0.6], E≦0.4, BPM≦90, Inst≧0.5, 音量-20%`);
    }

    // 突発イベント：急ブレーキ / 割り込まれ (>0.3g)
    if (isHardBraking) {
      minE = 0.1; maxE = Math.min(maxE, 0.4);
      minV = clamp(minV + 0.2, 0.4, 0.9); maxV = clamp(maxV + 0.2, 0.6, 1.0);
      minBpm = 60; maxBpm = Math.min(maxBpm, 90);
      minAc = 0.5;
      logs.push(`⚡ [突発イベント: 急ブレーキ (>0.3g)] ヒーリング移行 ➔ E-0.3(≦0.4), V+0.2, BPM≦90, Ac≧0.5`);
    }

    // ★最優先割り込み：DMS 眠気・疲労検知 (PERCLOS > 0.15)
    if (isDrowsy) {
      minV = 0.6; maxV = 1.0;
      minE = 0.8; maxE = 1.0;
      minBpm = 125; maxBpm = 200;
      minInst = 0.0; maxInst = 0.1;
      minAc = 0.0; maxAc = 0.35;
      volumeNote = "110% (覚醒強調)";
      logs.push(`🚨 [最優先割り込み: DMS眠気検知] 全制御上書き ➔ E≧0.80, V≧0.60, BPM≧125, ボーカル確定(Inst≦0.1)`);
    }

    // 上下限の整合保証
    if (minV > maxV) minV = maxV;
    if (minE > maxE) minE = maxE;
    if (minBpm > maxBpm) minBpm = Math.max(60, maxBpm - 25);
    if (minInst > maxInst) minInst = maxInst;
    if (minAc > maxAc) minAc = maxAc;

    return {
      isoStrategy,
      twoTapBox,
      finalBox: { minV, maxV, minE, maxE },
      minBpm,
      maxBpm,
      minInst,
      maxInst,
      minAc,
      maxAc,
      volumeNote,
      logs,
    };
  }, [
    selectedWho,
    selectedMood,
    speedKph,
    drivingMinutes,
    dynamicPhaseStep,
    weather,
    tempC,
    sunshineScore,
    season,
    timeOfDay,
    location,
    isDrowsy,
    isHardBraking,
    learnedShiftV,
    learnedShiftE,
  ]);

  // 5次元特徴空間での完全一致候補リスト（グラフ描画＆選曲用）
  const matchedTracks = useMemo(() => {
    const { finalBox, minBpm, maxBpm, minInst, maxInst, minAc, maxAc } = engineResult;
    return tracks.filter(
      (t) =>
        t.valence >= finalBox.minV &&
        t.valence <= finalBox.maxV &&
        t.energy >= finalBox.minE &&
        t.energy <= finalBox.maxE &&
        t.bpm >= minBpm &&
        t.bpm <= maxBpm &&
        t.instrumentalness >= minInst &&
        t.instrumentalness <= maxInst &&
        t.acousticness >= minAc &&
        t.acousticness <= maxAc
    );
  }, [tracks, engineResult]);

  // 5次元ペナルティ距離（レンジ内なら0、外れた分だけ距離を加算）
  const calcRangePenalty = (t: SongTrack) => {
    const { finalBox, minBpm, maxBpm, minInst, maxInst, minAc, maxAc } = engineResult;
    const rangeDist = (val: number, min: number, max: number) =>
      val < min ? min - val : val > max ? val - max : 0;

    const dV = rangeDist(t.valence, finalBox.minV, finalBox.maxV) * 2.0;
    const dE = rangeDist(t.energy, finalBox.minE, finalBox.maxE) * 2.2;
    const dBpm = (rangeDist(t.bpm, minBpm, maxBpm) / 100) * 1.2;
    const dInst = rangeDist(t.instrumentalness, minInst, maxInst) * 1.8;
    const dAc = rangeDist(t.acousticness, minAc, maxAc) * 0.8;

    // 範囲内の曲同士はターゲット中心への近さで微差をつける
    const cV = (finalBox.minV + finalBox.maxV) / 2;
    const cE = (finalBox.minE + finalBox.maxE) / 2;
    const centerBias = Math.hypot(t.valence - cV, t.energy - cE) * 0.15;

    return dV + dE + dBpm + dInst + dAc + centerBias;
  };

  // ====================================================================
  // 4. Spotify Track ID 自動検索 ＋ キャッシュ ＋ 再生準備
  // ====================================================================
  const loadAndPlayTrackAtIndex = async (targetIdx: number, pushHistory = true) => {
    const list = tracksRef.current;
    if (list.length === 0 || isChangingTrack) return;

    setIsChangingTrack(true);
    const normalizedIdx = ((targetIdx % list.length) + list.length) % list.length;
    const selected = list[normalizedIdx];

    if (pushHistory && phase === "running") {
      setHistoryIndices((prev) => [...prev, currentTrackIdx]);
    }
    setCurrentTrackIdx(normalizedIdx);
    setPlayedIds((prev) => [...prev.slice(-14), selected.trackId]); // 直近15曲の重複回避
    setDynamicPhaseStep((s) => s + 1);
    setStatusMessage(`[ID:${selected.trackId}] 再生準備中... ${selected.trackName}`);

    try {
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
          `[ID:${readyTrack.trackId} | 候補${matchedTracks.length}曲] 再生準備完了: ${readyTrack.artistName} - ${readyTrack.trackName}`
        );
      } else {
        setStatusMessage(`エラー: ${readyTrack.trackName} がSpotifyで見つかりませんでした`);
      }
    } catch (err) {
      console.error(err);
      setStatusMessage("Spotify検索エラー（環境変数を確認してください）");
    } finally {
      setTimeout(() => setIsChangingTrack(false), 400);
    }
  };

  // 次の曲のインデックスを選出（一覧表フル版 5次元スコアリング vs CSV ID順）
  const resolveNextIndex = (excludeTrackId?: number): number => {
    const list = tracksRef.current;
    if (list.length === 0) return 0;

    if (playMode === "order") {
      return (currentTrackIdx + 1) % list.length;
    }

    // 未再生寄りの候補を優先してスコアリング
    const scored = list
      .map((t, idx) => ({
        t,
        idx,
        penalty: calcRangePenalty(t) + (playedIds.includes(t.trackId) ? 0.6 : 0),
      }))
      .filter((x) => x.t.trackId !== excludeTrackId)
      .sort((a, b) => a.penalty - b.penalty);

    // 上位5曲からランダム選出（同じ条件で同じ1曲ばかりになるのを防ぐ）
    const topK = scored.slice(0, Math.min(5, scored.length));
    const chosen = topK[Math.floor(Math.random() * topK.length)];
    return chosen ? chosen.idx : 0;
  };

  // ====================================================================
  // 5. Supabase ログ保存
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
      iso_strategy: engineResult.isoStrategy,
      event_type: eventType,
      speed_kph: speedKph,
      weather: `${weather} (${displayWeatherStr})`,
      location: `${location} (${displayLocationStr})`,
      time_of_day: timeOfDay,
      season,
      is_drowsy: isDrowsy,
      is_hard_braking: isHardBraking,
      target_v_min: Number(engineResult.finalBox.minV.toFixed(2)),
      target_v_max: Number(engineResult.finalBox.maxV.toFixed(2)),
      target_e_min: Number(engineResult.finalBox.minE.toFixed(2)),
      target_e_max: Number(engineResult.finalBox.maxE.toFixed(2)),
      track_id: track.trackId,
      track_name: track.trackName,
      artist_name: track.artistName,
      track_valence: track.valence,
      track_energy: track.energy,
      track_bpm: Math.round(track.bpm),
      evaluation: evalLabel,
      evaluation_score: track.evaluation, // 0=未評価, 1=違和感なし(Match), 2=違和感あり(Bad)
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
  // 6. 評価ボタン（パターンA：押しても曲は進めない＋閉ループ重み更新）
  // ====================================================================
  const handleEvalClick = async (evalValue: 1 | 2) => {
    const current = tracksRef.current[currentTrackIdx];
    if (!current) return;

    const updatedList = [...tracksRef.current];
    updatedList[currentTrackIdx] = { ...current, evaluation: evalValue };
    tracksRef.current = updatedList;
    setTracks(updatedList);

    // 閉ループ学習：Match(1)ならその曲方向へ、Bad(2)なら逆方向へ重みを微調整
    const cV = (engineResult.finalBox.minV + engineResult.finalBox.maxV) / 2;
    const cE = (engineResult.finalBox.minE + engineResult.finalBox.maxE) / 2;
    const sign = evalValue === 1 ? 1 : -1;
    setLearnedShiftV((p) => clamp(p + sign * 0.05 * (current.valence - cV), -0.2, 0.2));
    setLearnedShiftE((p) => clamp(p + sign * 0.05 * (current.energy - cE), -0.2, 0.2));

    const evalText = evalValue === 1 ? "👍 違和感なし (Match)" : "👎 違和感あり (Bad)";
    setStatusMessage(`【評価完了】 ${evalText} を記録しました (値:${evalValue}) ※曲は継続再生`);

    await saveLogToSupabase(
      updatedList[currentTrackIdx],
      "EVAL",
      evalValue === 1 ? "Match" : "Bad"
    );
    setEvalComment("");
  };

  // ====================================================================
  // 7. 次の曲へ（スキップ／コンディション再確認して再選曲）
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
    const nextIdx = resolveNextIndex(current?.trackId);
    await loadAndPlayTrackAtIndex(nextIdx, true);
  };

  // ====================================================================
  // 8. 前の曲へ戻る（履歴を戻り、戻った曲の評価を0にリセット）
  // ====================================================================
  const handlePrevTrackClick = async () => {
    const list = tracksRef.current;
    if (isChangingTrack || list.length === 0) return;

    const prevIdx =
      historyIndices.length > 0
        ? historyIndices[historyIndices.length - 1]
        : (currentTrackIdx - 1 + list.length) % list.length;

    if (historyIndices.length > 0) {
      setHistoryIndices((prev) => prev.slice(0, -1));
    }

    const fromTrack = list[currentTrackIdx];
    await saveLogToSupabase(fromTrack, "PREV_FROM", "MovedToPrev");

    const updatedList = [...list];
    updatedList[prevIdx] = { ...updatedList[prevIdx], evaluation: 0 };
    tracksRef.current = updatedList;
    setTracks(updatedList);

    await saveLogToSupabase(updatedList[prevIdx], "PREV_TO", "EvaluationResetTo0");
    setStatusMessage("前の曲に戻りました（評価を 0 にリセットしました）");

    await loadAndPlayTrackAtIndex(prevIdx, false);
  };

  // ====================================================================
  // 拡張B：環境変化の検知
  // ====================================================================
  useEffect(() => {
    if (phase !== "running") return;
    const prev = prevEnvRef.current;
    if (
      prev.weather !== weather ||
      prev.location !== location ||
      prev.timeOfDay !== timeOfDay ||
      prev.season !== season
    ) {
      setEnvChangeBanner(
        `環境変化を検知（天気:${weather} / 場所:${location} / 時間:${timeOfDay} / 季節:${season}）。選曲基準を更新しました。`
      );
      prevEnvRef.current = { weather, location, timeOfDay, season };
    }
  }, [weather, location, timeOfDay, season, phase]);

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
    const nextIdx = resolveNextIndex(tracksRef.current[currentTrackIdx]?.trackId);
    loadAndPlayTrackAtIndex(nextIdx, true);
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
    setHistoryIndices([]);
    setPlayedIds([]);
    setLearnedShiftV(0);
    setLearnedShiftE(0);
    setEnvChangeBanner(null);

    const resetTracks = tracksRef.current.map((t) => ({ ...t, evaluation: 0 }));
    tracksRef.current = resetTracks;
    setTracks(resetTracks);

    setPhase("running");
    prevEnvRef.current = { weather, location, timeOfDay, season };
  };

  // running開始直後に最新の engineResult で最初の1曲を選出
  useEffect(() => {
    if (phase === "running" && playedIds.length === 0 && tracks.length > 0) {
      const firstIdx = playMode === "order" ? 0 : resolveNextIndex();
      loadAndPlayTrackAtIndex(firstIdx, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, tracks.length]);

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
    setDrivingMinutes(15);
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
          PHASE 1: 被験者セットアップ画面（2タップUI）
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
                  危険状態を解除し、安全適応楽曲の再生を再開する
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
                  新環境の曲へ切替
                </button>
              </div>
            )}

            {/* ステータスバー */}
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

            {/* 楽曲再生カード（Spotify Embed プレイヤー） */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div className="flex flex-wrap justify-between items-center gap-2 text-xs text-slate-400">
                <span>
                  被験者: <b className="text-white">{participantId}</b> |{" "}
                  {WHO_LABELS[selectedWho]} × {MOOD_LABELS[selectedMood]}
                </span>
                <div className="flex items-center gap-2">
                  <span className="bg-cyan-950 text-cyan-300 px-2.5 py-1 rounded border border-cyan-800 font-mono">
                    ISO: {engineResult.isoStrategy}
                  </span>
                  <span className="bg-slate-950 text-slate-300 px-2 py-1 rounded border border-slate-800 font-mono">
                    音量指示: {engineResult.volumeNote}
                  </span>
                </div>
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
                      ID:{currentTrack.trackId} | V:{currentTrack.valence} | E:{currentTrack.energy} | BPM:{currentTrack.bpm} | Inst:{currentTrack.instrumentalness} | Ac:{currentTrack.acousticness}
                    </p>
                  </div>

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

              {/* 評価セクション（パターンA：押しても曲は進めない） */}
              <div className="border-t border-slate-800 pt-5 space-y-4">
                <div className="text-sm font-bold text-slate-200">
                  この曲の評価（押しても曲は止まらず継続再生されます）
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
                    次の曲へ（現在の条件で再選曲） <SkipForward className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 右側：実験実施者用 コンディション操作 ＆ 中間処理可視化 */}
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

                {/* 再生モード切替 */}
                <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800 text-xs">
                  <button
                    onClick={() => setPlayMode("adaptive")}
                    className={`py-2 rounded-lg font-bold transition ${
                      playMode === "adaptive"
                        ? "bg-cyan-600 text-white"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    一覧表フル版（状況適応）
                  </button>
                  <button
                    onClick={() => setPlayMode("order")}
                    className={`py-2 rounded-lg font-bold transition ${
                      playMode === "order"
                        ? "bg-cyan-600 text-white"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    CSV Track_ID順（比較用）
                  </button>
                </div>

                {/* 車速・RPM・連続走行時間・気温 */}
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
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex justify-between mb-1">
                        <span>連続走行時間</span>
                        <span className="font-mono text-amber-400 font-bold">{drivingMinutes}分</span>
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
                    <div>
                      <div className="flex justify-between mb-1">
                        <span>気温 (平均{SEASON_AVG_TEMP[season]}℃)</span>
                        <span className="font-mono text-emerald-400 font-bold">{tempC}℃</span>
                      </div>
                      <input
                        type="range"
                        min={-5}
                        max={40}
                        value={tempC}
                        onChange={(e) => setTempC(Number(e.target.value))}
                        className="w-full accent-emerald-400"
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span>エンジン回転数 (CAN 0x30)</span>
                      <span className="font-mono text-slate-300">{engineRpm} RPM</span>
                    </div>
                    <input
                      type="range"
                      min={800}
                      max={7000}
                      step={100}
                      value={engineRpm}
                      onChange={(e) => setEngineRpm(Number(e.target.value))}
                      className="w-full accent-slate-400"
                    />
                  </div>
                </div>

                {/* 実測値表示 */}
                <div className="text-[11px] text-slate-400 flex items-center gap-1.5 bg-slate-950 px-3 py-2 rounded-lg border border-slate-800">
                  <MapPin className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span>実測: {displayWeatherStr} / 座標: {displayLocationStr}</span>
                </div>

                {/* 外部環境セレクト */}
                <div className="grid grid-cols-2 gap-2.5 text-xs">
                  <div>
                    <label className="text-slate-400 flex items-center gap-1 mb-1">
                      <CloudRain className="w-3.5 h-3.5" /> 天気
                    </label>
                    <select
                      value={weather}
                      onChange={(e) => {
                        setWeather(e.target.value);
                        setSunshineScore(e.target.value === "Sunny" ? 0.9 : e.target.value === "Cloudy" ? 0.5 : 0.1);
                      }}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2"
                    >
                      <option value="Sunny">☀️ 晴れ</option>
                      <option value="Cloudy">☁️ 曇り</option>
                      <option value="Rain">🌧️ 雨</option>
                      <option value="HeavyRain">⛈️ 豪雨/雷雨 (ワイパーHIGH)</option>
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
                      <option value="Normal">🏙️ 市街地・標準</option>
                      <option value="Coast">🏖️ 海辺</option>
                      <option value="Mountain">⛰️ 山道</option>
                      <option value="Field">🌾 野原</option>
                      <option value="Narrow">⚠️ 細道 (認知負荷軽減)</option>
                      <option value="Viewpoint">🌉 見晴らしの良い道</option>
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
                      <option value="Morning">🌅 朝 (5〜10時)</option>
                      <option value="Day">☀️ 昼 (10〜16時)</option>
                      <option value="Evening">🌇 夕方 (16〜18時)</option>
                      <option value="Night">🌃 夜 (18〜22時)</option>
                      <option value="LateNight">🌌 深夜 (22〜5時)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-slate-400 mb-1 block">🍂 季節</label>
                    <select
                      value={season}
                      onChange={(e) => setSeason(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2"
                    >
                      <option value="Spring">春 (3〜5月)</option>
                      <option value="Summer">夏 (6〜8月)</option>
                      <option value="Autumn">秋 (9〜11月)</option>
                      <option value="Winter">冬 (12〜2月)</option>
                    </select>
                  </div>
                </div>

                {/* 拡張A：緊急割り込み発火ボタン群 */}
                <div className="border-t border-slate-800 pt-3 space-y-2">
                  <div className="text-xs font-bold text-rose-400 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> 拡張A：緊急割り込み（音楽即停止＋警告音）
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

              {/* ラッセル円環ミニプロット ＋ 計算トレース */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-cyan-400 flex items-center gap-1">
                    <Zap className="w-3.5 h-3.5" /> ラッセル円環 ＆ パラメータ算出トレース
                  </span>
                  <span className="text-slate-400">完全一致: {matchedTracks.length}曲</span>
                </div>

                {/* 2Dマッピング可視化 */}
                <div className="grid grid-cols-12 gap-3 items-center">
                  <div className="col-span-5 relative aspect-square bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
                    <svg viewBox="0 0 100 100" className="w-full h-full">
                      <line x1="50" y1="0" x2="50" y2="100" stroke="#334155" strokeWidth="0.5" strokeDasharray="2,2" />
                      <line x1="0" y1="50" x2="100" y2="50" stroke="#334155" strokeWidth="0.5" strokeDasharray="2,2" />
                      {/* 2タップ初期枠 */}
                      <rect
                        x={engineResult.twoTapBox.minV * 100}
                        y={(1 - engineResult.twoTapBox.maxE) * 100}
                        width={(engineResult.twoTapBox.maxV - engineResult.twoTapBox.minV) * 100}
                        height={(engineResult.twoTapBox.maxE - engineResult.twoTapBox.minE) * 100}
                        fill="none"
                        stroke="#64748b"
                        strokeWidth="1"
                        strokeDasharray="2,2"
                      />
                      {/* 最終ウィンドウ */}
                      <rect
                        x={engineResult.finalBox.minV * 100}
                        y={(1 - engineResult.finalBox.maxE) * 100}
                        width={Math.max(2, (engineResult.finalBox.maxV - engineResult.finalBox.minV) * 100)}
                        height={Math.max(2, (engineResult.finalBox.maxE - engineResult.finalBox.minE) * 100)}
                        fill={isDrowsy ? "rgba(244,63,94,0.2)" : "rgba(6,182,212,0.2)"}
                        stroke={isDrowsy ? "#f43f5e" : "#22d3ee"}
                        strokeWidth="1.5"
                      />
                      {tracks.map((t) => {
                        const isCur = currentTrack?.trackId === t.trackId;
                        const isHit = matchedTracks.some((m) => m.trackId === t.trackId);
                        return (
                          <circle
                            key={t.trackId}
                            cx={t.valence * 100}
                            cy={(1 - t.energy) * 100}
                            r={isCur ? 3.2 : isHit ? 1.5 : 0.8}
                            fill={isCur ? "#facc15" : isHit ? "#22d3ee" : "#475569"}
                            opacity={isCur ? 1 : isHit ? 0.9 : 0.35}
                          />
                        );
                      })}
                    </svg>
                  </div>

                  {/* 最終5次元出力値 */}
                  <div className="col-span-7 space-y-1.5 font-mono text-[11px]">
                    <div className="bg-slate-950 px-2.5 py-1.5 rounded border border-slate-800 flex justify-between">
                      <span className="text-slate-400">Valence</span>
                      <span className="text-cyan-300">
                        {engineResult.finalBox.minV.toFixed(2)} ~ {engineResult.finalBox.maxV.toFixed(2)}
                      </span>
                    </div>
                    <div className="bg-slate-950 px-2.5 py-1.5 rounded border border-slate-800 flex justify-between">
                      <span className="text-slate-400">Energy</span>
                      <span className="text-cyan-300">
                        {engineResult.finalBox.minE.toFixed(2)} ~ {engineResult.finalBox.maxE.toFixed(2)}
                      </span>
                    </div>
                    <div className="bg-slate-950 px-2.5 py-1.5 rounded border border-slate-800 flex justify-between">
                      <span className="text-slate-400">BPM</span>
                      <span className="text-amber-300">
                        {engineResult.minBpm} ~ {engineResult.maxBpm}
                      </span>
                    </div>
                    <div className="bg-slate-950 px-2.5 py-1.5 rounded border border-slate-800 flex justify-between">
                      <span className="text-slate-400">Inst / Ac</span>
                      <span className="text-emerald-300">
                        I:[{engineResult.minInst.toFixed(1)},{engineResult.maxInst.toFixed(1)}] A:[{engineResult.minAc.toFixed(1)},{engineResult.maxAc.toFixed(1)}]
                      </span>
                    </div>
                  </div>
                </div>

                {/* 計算ログ */}
                <div className="bg-slate-950 p-3 rounded-xl font-mono text-[11px] text-slate-300 space-y-1 max-h-36 overflow-y-auto">
                  {engineResult.logs.map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
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