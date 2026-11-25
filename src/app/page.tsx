"use client";

import React, { useEffect, useMemo, useState } from "react";

// --- 型定義 ---
type Track = {
  id: string;
  title: string;
  artist: string;
  valence: number;
  energy: number;
  bpm: number;
  instrumentalness: number;
  vibe: string;
  spotifyId: string | null;
};

type WhoKey = "alone" | "partner" | "friend" | "family";
type MoodKey = "relax" | "refresh" | "party" | "focus" | "emotional" | "auto";
type TimeKey = "morning" | "noon" | "evening" | "night";
type WeatherKey = "clear" | "rain" | "heavy";
type SeasonKey = "normal" | "summer" | "winter";
type LocationKey = "normal" | "sea" | "mountain" | "field" | "scenic";
type DriveKey = "normal" | "jam" | "highway";
type EmergencyKey = "none" | "drowsy" | "brake" | "fatigue";

// --- Excel仕様マスタデータ ---
const WHO_CONFIG: Record<
  WhoKey,
  {
    label: string;
    vRange: [number, number];
    eRange: [number, number];
    bpmRange: [number, number];
    maxInst?: number;
    desc: string;
  }
> = {
  alone: {
    label: "ひとり",
    vRange: [0.0, 1.0],
    eRange: [0.0, 1.0],
    bpmRange: [0, 300],
    desc: "フィルターなし（好み最優先）",
  },
  partner: {
    label: "パートナー",
    vRange: [0.3, 0.7],
    eRange: [0.2, 0.7],
    bpmRange: [0, 120],
    desc: "V:0.3~0.7 / E:0.2~0.7 / BPM<120",
  },
  friend: {
    label: "友人",
    vRange: [0.5, 1.0],
    eRange: [0.5, 0.9],
    bpmRange: [100, 300],
    maxInst: 0.5,
    desc: "V:0.5~1.0 / E:0.5~0.9 / BPM>100 / ボーカル推奨",
  },
  family: {
    label: "グループ・家族",
    vRange: [0.4, 0.8],
    eRange: [0.3, 0.7],
    bpmRange: [80, 120],
    desc: "V:0.4~0.8 / E:0.3~0.7 / BPM:80~120",
  },
};

const MOOD_CONFIG: Record<
  MoodKey,
  {
    label: string;
    v?: number;
    e?: number;
    bpm?: number;
    instRule?: (inst: number) => boolean;
    vibe?: string;
  }
> = {
  relax: {
    label: "リラックス",
    v: 0.65,
    e: 0.25,
    bpm: 75,
    instRule: (i) => i > 0.5,
    vibe: "Chill",
  },
  refresh: {
    label: "気分転換・爽快",
    v: 0.8,
    e: 0.7,
    bpm: 115,
    instRule: (i) => i < 0.5,
    vibe: "Refresh",
  },
  party: {
    label: "盛り上がり",
    v: 0.85,
    e: 0.85,
    bpm: 140,
    instRule: (i) => i < 0.3,
    vibe: "Party",
  },
  focus: {
    label: "集中・眠気覚まし",
    v: 0.5,
    e: 0.75,
    bpm: 125,
    instRule: (i) => i > 0.6,
    vibe: "Focus",
  },
  emotional: {
    label: "エモい・浸りたい",
    v: 0.35,
    e: 0.4,
    bpm: 85,
    instRule: (i) => i < 0.5,
    vibe: "Emotional",
  },
  auto: {
    label: "おまかせ",
  },
};

const TIME_CONFIG: Record<
  TimeKey,
  { label: string; v: number; e: number; bpm: [number, number] }
> = {
  morning: { label: "朝 (6-10時)", v: 0.6, e: 0.6, bpm: [100, 120] },
  noon: { label: "昼 (10-16時)", v: 0.5, e: 0.5, bpm: [100, 120] },
  evening: { label: "夕方 (16-18時)", v: 0.4, e: 0.4, bpm: [80, 100] },
  night: { label: "夜/深夜 (18-5時)", v: 0.3, e: 0.3, bpm: [60, 90] },
};

const clamp = (val: number, min: number, max: number) =>
  Math.min(max, Math.max(min, val));

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function extractSpotifyId(row: string[]): string | null {
  for (let i = row.length - 1; i >= 0; i--) {
    const cell = row[i] || "";
    const match = cell.match(/spotify:track:([a-zA-Z0-9]{22})/);
    if (match) return match[1];
    const urlMatch = cell.match(/track\/([a-zA-Z0-9]{22})/);
    if (urlMatch) return urlMatch[1];
  }
  return null;
}

export default function Home() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  // 2タップUI
  const [who, setWho] = useState<WhoKey>("alone");
  const [mood, setMood] = useState<MoodKey>("refresh");

  // コンテキスト
  const [time, setTime] = useState<TimeKey>("noon");
  const [weather, setWeather] = useState<WeatherKey>("clear");
  const [season, setSeason] = useState<SeasonKey>("normal");
  const [location, setLocation] = useState<LocationKey>("normal");
  const [drive, setDrive] = useState<DriveKey>("normal");

  // 例外（緊急割り込み）
  const [emergency, setEmergency] = useState<EmergencyKey>("none");

  // ISO原理ステップ (1〜3曲目)
  const [isoStep, setIsoStep] = useState<number>(1);

  // 選択中トラック
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  // フィードバック送信状態
  const [saving, setSaving] = useState(false);
  const [feedbackStatus, setFeedbackStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // CSV読み込み
  useEffect(() => {
    fetch("/sdv_music_db.csv")
      .then((res) => res.text())
      .then((text) => {
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length < 2) return;
        const parsed: Track[] = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = parseCSVLine(lines[i]);
          if (cols.length < 8) continue;
          const v = parseFloat(cols[3]);
          const e = parseFloat(cols[4]);
          const bpm = parseFloat(cols[5]);
          const inst = parseFloat(cols[6]);
          if (isNaN(v) || isNaN(e) || isNaN(bpm)) continue;
          parsed.push({
            id: `${i}-${cols[1]}`,
            title: cols[1] || "Unknown",
            artist: cols[2] || "Unknown",
            valence: v,
            energy: e,
            bpm,
            instrumentalness: isNaN(inst) ? 0 : inst,
            vibe: cols[7] || "",
            spotifyId: extractSpotifyId(cols),
          });
        }
        setTracks(parsed);
      })
      .finally(() => setLoading(false));
  }, []);

  // --- 選曲ロジック計算 ---
  const calculation = useMemo(() => {
    let startV = TIME_CONFIG[time].v;
    let startE = TIME_CONFIG[time].e;
    let startBpmRange: [number, number] = [...TIME_CONFIG[time].bpm];

    if (weather === "clear") {
      startV += 0.1;
      startE += 0.1;
    } else if (weather === "rain") {
      startV -= 0.1;
      startE -= 0.2;
      startBpmRange = [75, 105];
    } else if (weather === "heavy") {
      startV -= 0.2;
      startE -= 0.3;
      startBpmRange = [60, 90];
    }

    if (season === "summer") {
      startV += 0.1;
      startE += 0.1;
    } else if (season === "winter") {
      startV -= 0.1;
      startE -= 0.1;
    }

    let contextVibe: string | undefined;
    if (location === "sea") {
      startV += 0.15;
      startE += 0.1;
      startBpmRange = [105, 125];
      contextVibe = "Refresh";
    } else if (location === "mountain") {
      startV += 0.05;
      startE += 0.15;
      startBpmRange = [110, 130];
      contextVibe = "Focus";
    } else if (location === "field") {
      startV = 0.6;
      startE = 0.4;
      startBpmRange = [80, 105];
    } else if (location === "scenic") {
      startV = 0.85;
      startE = 0.7;
      startBpmRange = [110, 135];
    }

    if (drive === "jam") {
      startV -= 0.2;
      startE += 0.2;
      startBpmRange = [70, 100];
    } else if (drive === "highway") {
      startV += 0.1;
      startE += 0.1;
      startBpmRange = [100, 120];
    }

    startV = clamp(startV, 0, 1);
    startE = clamp(startE, 0, 1);

    const whoRule = WHO_CONFIG[who];
    const moodRule = MOOD_CONFIG[mood];

    let goalV = mood === "auto" ? startV : moodRule.v ?? startV;
    let goalE = mood === "auto" ? startE : moodRule.e ?? startE;
    let goalBpmMin = mood === "auto" ? startBpmRange[0] : moodRule.bpm ?? 100;
    let goalBpmMax = mood === "auto" ? startBpmRange[1] : moodRule.bpm ?? 100;
    let targetVibe = moodRule.vibe ?? contextVibe;
    let instRule = moodRule.instRule;

    let isClipped = false;
    const rawGoalV = goalV;
    const rawGoalE = goalE;
    goalV = clamp(goalV, whoRule.vRange[0], whoRule.vRange[1]);
    goalE = clamp(goalE, whoRule.eRange[0], whoRule.eRange[1]);
    if (goalV !== rawGoalV || goalE !== rawGoalE) isClipped = true;

    const ratio = isoStep / 3;
    let targetV = startV + (goalV - startV) * ratio;
    let targetE = startE + (goalE - startE) * ratio;
    let targetBpmMin =
      startBpmRange[0] + (goalBpmMin - startBpmRange[0]) * ratio;
    let targetBpmMax =
      startBpmRange[1] + (goalBpmMax - startBpmRange[1]) * ratio;

    let emergencyMessage = "";
    if (emergency === "drowsy") {
      targetV = startV;
      targetE = 0.85;
      targetBpmMin = 120;
      targetBpmMax = 180;
      instRule = (i) => i < 0.3;
      targetVibe = "Party";
      emergencyMessage =
        "【強い警告音】眠気・注意散漫を検知。Whoの制限を解除し、強制的に高覚醒・アップテンポ曲へ切り替えます。";
    } else if (emergency === "brake") {
      targetV = clamp(startV + 0.2, 0, 1);
      targetE = clamp(startE - 0.3, 0, 1);
      targetBpmMin = 50;
      targetBpmMax = 80;
      instRule = (i) => i > 0.5;
      targetVibe = "Chill";
      emergencyMessage =
        "【マイルド音声】急ブレーキを検知。心拍数を落ち着かせるため、スロー＆チルな楽曲へ一時変更します。";
    } else if (emergency === "fatigue") {
      targetV = clamp(startV + 0.1, 0, 1);
      targetE = clamp(startE + 0.15, 0, 1);
      targetBpmMin = 100;
      targetBpmMax = 120;
      instRule = (i) => i < 0.5;
      targetVibe = "Refresh";
      emergencyMessage =
        "【休憩提案音声】長時間走行の疲労を検知。疲労軽減に最適な中テンポ・リフレッシュ曲へ介入します。";
    }

    const filtered =
      emergency !== "none"
        ? tracks
        : tracks.filter((t) => {
            const inV =
              t.valence >= whoRule.vRange[0] && t.valence <= whoRule.vRange[1];
            const inE =
              t.energy >= whoRule.eRange[0] && t.energy <= whoRule.eRange[1];
            const inBpm =
              t.bpm >= whoRule.bpmRange[0] && t.bpm <= whoRule.bpmRange[1];
            const inInst =
              whoRule.maxInst !== undefined
                ? t.instrumentalness <= whoRule.maxInst
                : true;
            return inV && inE && inBpm && inInst;
          });

    const pool = filtered.length > 0 ? filtered : tracks;

    const scored = pool
      .map((t) => {
        const sv = (1.0 - Math.abs(targetV - t.valence)) * 3.0;
        const se = (1.0 - Math.abs(targetE - t.energy)) * 3.0;

        let bpmDiff = 0;
        if (t.bpm < targetBpmMin) bpmDiff = targetBpmMin - t.bpm;
        else if (t.bpm > targetBpmMax) bpmDiff = t.bpm - targetBpmMax;
        const sbpm = Math.max(0.0, 1.0 - bpmDiff / 60.0) * 2.0;

        const svibe =
          targetVibe && t.vibe.toLowerCase() === targetVibe.toLowerCase()
            ? 1.0
            : 0.0;
        const sinst = instRule && instRule(t.instrumentalness) ? 1.0 : 0.0;

        const total = sv + se + sbpm + svibe + sinst;
        return {
          track: t,
          total,
          breakdown: { sv, se, sbpm, svibe, sinst },
        };
      })
      .sort((a, b) => b.total - a.total);

    return {
      startV,
      startE,
      goalV,
      goalE,
      targetV,
      targetE,
      targetBpmMin,
      targetBpmMax,
      targetVibe,
      isClipped,
      emergencyMessage,
      filteredCount: filtered.length,
      ranked: scored.slice(0, 5),
    };
  }, [
    tracks,
    who,
    mood,
    time,
    weather,
    season,
    location,
    drive,
    emergency,
    isoStep,
  ]);

  const activeItem =
    calculation.ranked.find((r) => r.track.id === selectedTrackId) ||
    calculation.ranked[0];

  // 条件や曲が変わったらフィードバック表示をリセット
  useEffect(() => {
    setFeedbackStatus(null);
  }, [
    who,
    mood,
    time,
    weather,
    season,
    location,
    drive,
    emergency,
    isoStep,
    activeItem?.track.id,
  ]);

  // --- Supabaseへ評価ログを保存 ---
  const handleFeedback = async (feedbackValue: 1 | 0) => {
    if (!activeItem || saving) return;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      setFeedbackStatus({
        type: "error",
        message:
          "環境変数（NEXT_PUBLIC_SUPABASE_URL / ANON_KEY）が設定されていません。",
      });
      return;
    }

    setSaving(true);
    setFeedbackStatus(null);

    const payload = {
      feedback: feedbackValue, // 1: 違和感なし, 0: 違和感あり
      who,
      mood,
      time_of_day: time,
      weather,
      season,
      location,
      drive_mode: drive,
      emergency,
      iso_step: isoStep,
      target_valence: Number(calculation.targetV.toFixed(3)),
      target_energy: Number(calculation.targetE.toFixed(3)),
      target_bpm_min: Math.round(calculation.targetBpmMin),
      target_bpm_max: Math.round(calculation.targetBpmMax),
      target_vibe: calculation.targetVibe ?? null,
      track_title: activeItem.track.title,
      track_artist: activeItem.track.artist,
      track_valence: activeItem.track.valence,
      track_energy: activeItem.track.energy,
      track_bpm: activeItem.track.bpm,
      track_vibe: activeItem.track.vibe,
      total_score: Number(activeItem.total.toFixed(2)),
      spotify_id: activeItem.track.spotifyId,
    };

    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/experiment_logs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }

      setFeedbackStatus({
        type: "success",
        message:
          feedbackValue === 1
            ? "「違和感なし」をDBに保存しました！"
            : "「違和感あり」をDBに保存しました！",
      });
    } catch (err) {
      setFeedbackStatus({
        type: "error",
        message: `保存エラー: ${
          err instanceof Error ? err.message : "不明なエラー"
        }`,
      });
    } finally {
      setSaving(false);
    }
  };

  const uriCount = useMemo(
    () => tracks.filter((t) => t.spotifyId).length,
    [tracks]
  );

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* ヘッダー */}
        <header className="flex flex-col md:flex-row md:items-end justify-between border-b border-slate-800 pb-4 gap-2">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-white">
              SDV AI-DJ 選曲シミュレーター
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              {loading
                ? "DB読込中..."
                : `DB読込: 全${tracks.length}曲 (URI登録済: ${uriCount}曲) / Who通過: ${calculation.filteredCount}曲`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["none", "通常走行"],
                ["drowsy", "⚠️ 眠気検知"],
                ["brake", "🛑 急ブレーキ"],
                ["fatigue", "☕ 疲労蓄積"],
              ] as [EmergencyKey, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => {
                  setEmergency(k);
                  setSelectedTrackId(null);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  emergency === k
                    ? k === "none"
                      ? "bg-emerald-600 text-white"
                      : "bg-rose-600 text-white animate-pulse"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        {calculation.emergencyMessage && (
          <div className="bg-rose-950/80 border border-rose-500 text-rose-100 px-4 py-3 rounded-xl text-sm font-medium">
            {calculation.emergencyMessage}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* 左カラム：操作パネル */}
          <section className="lg:col-span-5 space-y-5">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-4">
              <h2 className="text-sm font-bold text-sky-400 uppercase tracking-wider">
                Step 1. 2タップUI（Who & Mood）
              </h2>

              <div>
                <label className="text-xs text-slate-400 block mb-2">
                  Who（誰と）※許容境界の壁
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(WHO_CONFIG) as WhoKey[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => {
                        setWho(k);
                        setSelectedTrackId(null);
                      }}
                      className={`p-2.5 rounded-xl text-left border transition ${
                        who === k
                          ? "bg-sky-600/20 border-sky-400 text-white"
                          : "bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700"
                      }`}
                    >
                      <div className="font-semibold text-sm">
                        {WHO_CONFIG[k].label}
                      </div>
                      <div className="text-[10px] opacity-75 mt-0.5">
                        {WHO_CONFIG[k].desc}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-2">
                  Mood（なりたい気分）※ゴール＆加点
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(MOOD_CONFIG) as MoodKey[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => {
                        setMood(k);
                        setSelectedTrackId(null);
                      }}
                      className={`px-3 py-2 rounded-xl text-sm font-medium border transition ${
                        mood === k
                          ? "bg-indigo-600/30 border-indigo-400 text-white"
                          : "bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700"
                      }`}
                    >
                      {MOOD_CONFIG[k].label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
              <h2 className="text-sm font-bold text-emerald-400 uppercase tracking-wider">
                Step 2 & 3. 環境コンテキスト（出発点）
              </h2>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <label className="text-xs text-slate-400">時間帯</label>
                  <select
                    value={time}
                    onChange={(e) => setTime(e.target.value as TimeKey)}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-lg p-2"
                  >
                    {(Object.keys(TIME_CONFIG) as TimeKey[]).map((k) => (
                      <option key={k} value={k}>
                        {TIME_CONFIG[k].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-slate-400">天気</label>
                  <select
                    value={weather}
                    onChange={(e) => setWeather(e.target.value as WeatherKey)}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-lg p-2"
                  >
                    <option value="clear">晴れ・曇り (+0.1/+0.1)</option>
                    <option value="rain">雨 (-0.1/-0.2)</option>
                    <option value="heavy">雪・豪雨 (-0.2/-0.3)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs text-slate-400">季節</label>
                  <select
                    value={season}
                    onChange={(e) => setSeason(e.target.value as SeasonKey)}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-lg p-2"
                  >
                    <option value="normal">春・秋 (補正なし)</option>
                    <option value="summer">夏 (+0.1/+0.1)</option>
                    <option value="winter">冬 (-0.1/-0.1)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs text-slate-400">ロケーション</label>
                  <select
                    value={location}
                    onChange={(e) => setLocation(e.target.value as LocationKey)}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-lg p-2"
                  >
                    <option value="normal">市街地・通常</option>
                    <option value="sea">海辺 (+Refresh)</option>
                    <option value="mountain">山道 (+Focus)</option>
                    <option value="field">野原 (穏やか)</option>
                    <option value="scenic">見晴らしのいい道</option>
                  </select>
                </div>

                <div className="col-span-2">
                  <label className="text-xs text-slate-400">走行状況</label>
                  <select
                    value={drive}
                    onChange={(e) => setDrive(e.target.value as DriveKey)}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-lg p-2"
                  >
                    <option value="normal">通常走行</option>
                    <option value="jam">渋滞 (V-0.2 / E+0.2)</option>
                    <option value="highway">高速道路 (中テンポ維持)</option>
                  </select>
                </div>
              </div>
            </div>
          </section>

          {/* 右カラム：計算結果 & プレイヤー */}
          <section className="lg:col-span-7 space-y-5">
            {/* ISO原理ステップ */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-amber-400 uppercase tracking-wider">
                  ISO原理 遷移ステップ & ターゲット値
                </h2>
                <div className="flex gap-1.5">
                  {[1, 2, 3].map((step) => (
                    <button
                      key={step}
                      onClick={() => {
                        setIsoStep(step);
                        setSelectedTrackId(null);
                      }}
                      className={`px-3 py-1 rounded-lg text-xs font-bold transition ${
                        isoStep === step
                          ? "bg-amber-500 text-slate-950"
                          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      {step}曲目{step === 3 ? " (到達)" : ""}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <div className="text-[11px] text-slate-400">出発点 (環境)</div>
                  <div className="text-sm font-mono mt-1">
                    V:{calculation.startV.toFixed(2)} / E:
                    {calculation.startE.toFixed(2)}
                  </div>
                </div>
                <div className="bg-amber-500/10 p-3 rounded-xl border border-amber-500/40">
                  <div className="text-[11px] text-amber-300 font-semibold">
                    今回のターゲット ({isoStep}/3)
                  </div>
                  <div className="text-sm font-mono font-bold text-white mt-1">
                    V:{calculation.targetV.toFixed(2)} / E:
                    {calculation.targetE.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-amber-200/80 mt-0.5">
                    BPM:{Math.round(calculation.targetBpmMin)}~
                    {Math.round(calculation.targetBpmMax)} / Vibe:
                    {calculation.targetVibe || "指定なし"}
                  </div>
                </div>
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <div className="text-[11px] text-slate-400">
                    到達点 (Mood)
                    {calculation.isClipped && (
                      <span className="ml-1 text-rose-400">※壁制限済</span>
                    )}
                  </div>
                  <div className="text-sm font-mono mt-1">
                    V:{calculation.goalV.toFixed(2)} / E:
                    {calculation.goalE.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>

            {/* Spotify プレイヤー & 違和感フィードバック */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-4">
              {activeItem ? (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs text-emerald-400 font-semibold">
                        NOW PLAYING (スコア: {activeItem.total.toFixed(2)} / 10.00)
                      </div>
                      <div className="text-lg font-bold text-white">
                        {activeItem.track.title}
                      </div>
                      <div className="text-sm text-slate-400">
                        {activeItem.track.artist}
                      </div>
                    </div>
                    <div className="text-right text-xs font-mono text-slate-400">
                      <div>
                        V:{activeItem.track.valence.toFixed(2)} / E:
                        {activeItem.track.energy.toFixed(2)}
                      </div>
                      <div>
                        BPM:{Math.round(activeItem.track.bpm)} / Vibe:
                        {activeItem.track.vibe}
                      </div>
                    </div>
                  </div>

                  {activeItem.track.spotifyId ? (
                    <iframe
                      key={activeItem.track.spotifyId}
                      src={`https://open.spotify.com/embed/track/${activeItem.track.spotifyId}?utm_source=generator&theme=0`}
                      width="100%"
                      height="152"
                      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                      loading="lazy"
                      className="rounded-xl"
                    />
                  ) : (
                    <div className="p-4 bg-slate-950 rounded-xl text-xs text-slate-400">
                      ※この曲はCSVにSpotify URIが登録されていません。
                    </div>
                  )}

                  {/* 違和感あり / なし 評価ボタン */}
                  <div className="pt-2 border-t border-slate-800 space-y-2">
                    <div className="text-xs text-slate-400">
                      この選曲の評価をDB（experiment_logs）に記録：
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        disabled={saving}
                        onClick={() => handleFeedback(1)}
                        className="py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-sm transition flex items-center justify-center gap-2"
                      >
                        <span>👍 違和感なし</span>
                      </button>
                      <button
                        disabled={saving}
                        onClick={() => handleFeedback(0)}
                        className="py-2.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-bold text-sm transition flex items-center justify-center gap-2"
                      >
                        <span>👎 違和感あり</span>
                      </button>
                    </div>
                    {feedbackStatus && (
                      <div
                        className={`text-xs px-3 py-2 rounded-lg ${
                          feedbackStatus.type === "success"
                            ? "bg-emerald-950/70 text-emerald-300 border border-emerald-700/50"
                            : "bg-rose-950/70 text-rose-300 border border-rose-700/50"
                        }`}
                      >
                        {feedbackStatus.message}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-sm text-slate-400">
                  楽曲データを読み込み中、または該当曲がありません。
                </div>
              )}
            </div>

            {/* スコアランキング TOP 5 */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                スコアリング上位 TOP 5（クリックで試聴）
              </h3>
              <div className="divide-y divide-slate-800">
                {calculation.ranked.map((item, idx) => {
                  const isSelected = activeItem?.track.id === item.track.id;
                  return (
                    <button
                      key={item.track.id}
                      onClick={() => setSelectedTrackId(item.track.id)}
                      className={`w-full py-2.5 px-3 text-left flex items-center justify-between rounded-lg transition ${
                        isSelected ? "bg-slate-800/90" : "hover:bg-slate-800/40"
                      }`}
                    >
                      <div className="min-w-0 pr-3">
                        <div className="text-sm font-semibold text-white truncate">
                          <span className="text-amber-400 mr-2">#{idx + 1}</span>
                          {item.track.title}
                        </div>
                        <div className="text-xs text-slate-400 truncate">
                          {item.track.artist} ・ V:{item.track.valence.toFixed(2)}{" "}
                          E:{item.track.energy.toFixed(2)} BPM:
                          {Math.round(item.track.bpm)} [{item.track.vibe}]
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-mono font-bold text-emerald-400">
                          {item.total.toFixed(2)} pt
                        </div>
                        <div className="text-[10px] font-mono text-slate-400">
                          V:{item.breakdown.sv.toFixed(1)} E:
                          {item.breakdown.se.toFixed(1)} B:
                          {item.breakdown.sbpm.toFixed(1)} +
                          {(
                            item.breakdown.svibe + item.breakdown.sinst
                          ).toFixed(0)}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}