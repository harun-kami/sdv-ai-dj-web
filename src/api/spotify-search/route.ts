import { NextRequest, NextResponse } from "next/server";

// サーバー側でアプリ用アクセストークンをメモリキャッシュ（ログイン不要のClient Credentials方式）
let cachedToken = "";
let tokenExpiresAt = 0;

async function getSpotifyAppToken(): Promise<string | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const authString = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authString}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    cache: "no-store",
  });

  if (!res.ok) return null;

  const data = await res.json();
  cachedToken = data.access_token || "";
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const trackName = searchParams.get("track") || "";
  const artistName = searchParams.get("artist") || "";

  if (!trackName) {
    return NextResponse.json({ error: "track is required" }, { status: 400 });
  }

  const token = await getSpotifyAppToken();
  if (!token) {
    return NextResponse.json(
      { error: "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET が未設定です" },
      { status: 500 }
    );
  }

  const query = encodeURIComponent(`${trackName} ${artistName}`.trim());
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    return NextResponse.json(
      { error: `Spotify search failed: ${res.status}` },
      { status: res.status }
    );
  }

  const data = await res.json();
  const item = data?.tracks?.items?.[0];

  if (!item) {
    return NextResponse.json({ found: false, spotifyId: "", uri: "" });
  }

  return NextResponse.json({
    found: true,
    spotifyId: item.id as string,
    uri: item.uri as string,
    previewUrl: item.preview_url || null,
  });
}