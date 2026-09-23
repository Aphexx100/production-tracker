// Reading uploaded call transcripts. Subtitle files keep their spoken text
// but lose timestamps and cue numbers, so the AI sees only what was said.
export const TRANSCRIPT_ACCEPT = '.txt,.md,.vtt,.srt,.json,.csv,text/plain';
export const MAX_TRANSCRIPT_CHARS = 400_000;

const TIME = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?/;

/** Subtitle (.vtt/.srt), JSON transcript or plain text -> readable lines. */
export function parseTranscript(name, raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  if (/\.json$/i.test(name || '')) {
    const fromJson = parseJsonTranscript(text);
    if (fromJson) return fromJson;
  }
  const lines = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line) { lines.push(''); continue; }
    if (/^WEBVTT/i.test(line) || /^NOTE\b/i.test(line) || /^STYLE$/i.test(line) || /^\d+$/.test(line) || TIME.test(line)) continue;
    line = line
      .replace(/<v\s+([^>]+)>/gi, (_, who) => `${who.trim()}: `) // VTT speaker tags
      .replace(/<\/?[cvibu][^>]*>/gi, '')
      .replace(/\{\\[^}]*\}/g, '') // ASS/SSA overrides
      .trim();
    if (line) lines.push(line);
  }
  return tidy(lines);
}

function parseJsonTranscript(text) {
  try {
    const data = JSON.parse(text);
    const segs = Array.isArray(data) ? data : data.segments || data.results || data.transcript || data.utterances;
    if (!Array.isArray(segs)) return null;
    const lines = segs.map((s) => {
      if (typeof s === 'string') return s.trim();
      const who = s.speaker || s.speaker_label || s.name || '';
      const what = s.text || s.content || s.transcript || s.value || '';
      return `${who ? `${who}: ` : ''}${String(what).trim()}`.trim();
    }).filter(Boolean);
    return lines.length ? tidy(lines) : null;
  } catch { return null; }
}

/** Join wrapped lines of one speaker, drop repeats, keep paragraphs. */
function tidy(lines) {
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    const prev = out[out.length - 1];
    if (prev === line) continue; // subtitle files often repeat a cue
    const speaker = /^[^:]{1,40}:\s/.test(line);
    if (prev && !speaker && !/[.!?…:]$/.test(prev) && prev.length < 200) out[out.length - 1] = `${prev} ${line}`;
    else out.push(line);
  }
  return out.join('\n').trim();
}

export const wordCount = (text) => (String(text || '').match(/\S+/g) || []).length;

export async function readTranscriptFile(file) {
  if (file.size > 4 * 1024 * 1024) throw new Error('That file is larger than 4 MB. Transcripts are plain text — export it as .txt, .vtt or .srt.');
  const text = parseTranscript(file.name, await file.text());
  if (!text) throw new Error('No readable text found in that file.');
  if (text.length > MAX_TRANSCRIPT_CHARS) throw new Error(`The transcript is too long (${text.length} characters, limit ${MAX_TRANSCRIPT_CHARS}). Split the call into several days.`);
  return { name: file.name.slice(0, 200), text };
}

/** Turn the AI's sections into editor HTML. */
export function summaryToHtml(summary) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return (summary.sections || [])
    .map((sec) => `<h2>${esc(sec.heading)}</h2><ul>${sec.bullets.map((b) => `<li><p>${esc(b)}</p></li>`).join('')}</ul>`)
    .join('');
}
