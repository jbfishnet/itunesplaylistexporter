const path = require("path");

const MODEL = "claude-opus-5";

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Best-guess song title. Empty string if you truly can't tell." },
    artist: { type: "string", description: "Best-guess artist name. Empty string if you truly can't tell." },
    album: { type: "string", description: "Best-guess album name. Empty string — most filenames won't carry this." },
    genre: { type: "string", description: "Best-guess genre, only if you're confident from artist/song knowledge. Empty string otherwise." },
    year: { type: "string", description: "4-digit release year as a string, only if known. Empty string otherwise." },
    confidence: {
      type: "string",
      enum: ["high", "low"],
      description: "'high' only when you're confident in both title and artist; 'low' for any guess, hunch, or partial read.",
    },
    reasoning: { type: "string", description: "One short sentence: what in the filename led to this guess." },
  },
  required: ["title", "artist", "album", "genre", "year", "confidence", "reasoning"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You extract song metadata from a messy digital music filename — no other context is available. Filenames commonly follow patterns like "Artist - Title.mp3", "Title - Artist (Remix) (192 kbps).mp3", or have no discernible structure at all.

Strip filler that isn't part of the real title or artist: file quality/format tags ("192 kbps", "HQ", "320", "FLAC"), generic upload/video annotations ("Official Video", "Lyrics", "Audio", "HD"), and track numbers — unless they're genuinely part of the song's actual name.

Use your own knowledge of real songs and artists to disambiguate and correct obvious misspellings when the filename resembles something you recognize. Never invent a title, artist, album, genre, or year you have no real basis for — leave that field as an empty string instead. It's fine, even encouraged, to make your best reasonable guess for title/artist even when you're not fully sure — set confidence to "low" in that case rather than leaving the fields blank, since any guess is more useful here than nothing. Only use confidence "high" when you're confident in both title and artist.`;

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    const Anthropic = require("@anthropic-ai/sdk");
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

function extractJsonText(response) {
  const block = (response.content || []).find((b) => b.type === "text");
  return block?.text || "";
}

/**
 * Guesses title/artist/album/genre/year from a filename alone, via Claude —
 * the last resort for the Not Found tab, when tags are missing/sparse and
 * neither the local index nor the iTunes Search API could identify the
 * track. The caller decides what to do with a "low" confidence guess
 * (surface for manual review vs. auto-apply); this always tries to produce
 * something, per the whole point of this feature — any reasonable guess
 * beats a permanent "not found".
 *
 * A no-op (never touches the network) whenever ANTHROPIC_API_KEY isn't
 * configured, same inert-until-configured posture as acoustId.js.
 */
async function extractMetadataFromFilename(filePath, { anthropicClient } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: "not_configured",
      errorMessage: "No ANTHROPIC_API_KEY configured — add one to .env to enable AI metadata guessing.",
    };
  }

  const filename = path.basename(filePath);
  const client = anthropicClient || getClient();

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      output_config: { effort: "low", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Filename: ${filename}` }],
    });
  } catch (err) {
    return { ok: false, error: "api_error", errorMessage: err.message };
  }

  if (response.stop_reason === "refusal") {
    return { ok: false, error: "refused", errorMessage: "Claude declined to process this filename." };
  }

  let parsed;
  try {
    parsed = JSON.parse(extractJsonText(response));
  } catch {
    return { ok: false, error: "invalid_response", errorMessage: "Claude's response wasn't valid JSON." };
  }

  return {
    ok: true,
    suggestion: {
      title: parsed.title || "",
      artist: parsed.artist || "",
      album: parsed.album || "",
      genre: parsed.genre || "",
      year: parsed.year || "",
      confidence: parsed.confidence === "high" ? "high" : "low",
      reasoning: parsed.reasoning || "",
    },
  };
}

module.exports = { extractMetadataFromFilename };
