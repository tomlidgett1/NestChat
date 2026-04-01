/**
 * Outbound iMessage text normalisation — mirrors pipeline.ts so automations and
 * chat replies render bold the same way (**…** → Unicode mathematical bold).
 */

const _BOLD_UPPER: Record<string, string> = {};
const _BOLD_LOWER: Record<string, string> = {};
const _BOLD_DIGIT: Record<string, string> = {};
for (let c = 65; c <= 90; c++) _BOLD_UPPER[String.fromCharCode(c)] = String.fromCodePoint(0x1D5D4 + (c - 65));
for (let c = 97; c <= 122; c++) _BOLD_LOWER[String.fromCharCode(c)] = String.fromCodePoint(0x1D5EE + (c - 97));
for (let c = 48; c <= 57; c++) _BOLD_DIGIT[String.fromCharCode(c)] = String.fromCodePoint(0x1D7EC + (c - 48));
const _BOLD_MAP: Record<string, string> = { ..._BOLD_UPPER, ..._BOLD_LOWER, ..._BOLD_DIGIT };

function toUnicodeBold(text: string): string {
  return [...text].map(c => _BOLD_MAP[c] ?? c).join('');
}

function uppercaseFirst(s: string): string {
  if (!s) return s;
  const i = s.search(/[a-zA-Z]/);
  if (i < 0) return s;
  return s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
}

/** Same behaviour as pipeline.cleanResponse — use before sending assistant text over Linq. */
export function cleanResponse(text: string): string {
  const cleaned = text
    .replace(/<cite[^>]*>|<\/cite>/g, '')
    .replace(/\s*cite(?:turn\d+search\d+)+/gi, '')
    .replace(/[\u3010\u3011][^\u3010\u3011]*[\u3010\u3011]?/g, '')
    .replace(/\s*\((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/\S*)?\)/gi, '')
    .replace(/\*\*([\s\S]+?)\*\*/g, (_m, p1) => toUnicodeBold(p1.trim()))
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$2')
    .replace(/[''`'](https?:\/\/[^\s''`']+)[''`']?/g, '$1')
    .replace(/`(https?:\/\/[^\s`]+)`/g, '$1')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n([,.:;!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/  +/g, ' ')
    .trim();
  return uppercaseFirst(cleaned);
}
