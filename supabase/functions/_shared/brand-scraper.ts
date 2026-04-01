import { DOMParser, type Document, type Element } from 'npm:linkedom@0.16.11';
import { getAdminClient } from './supabase.ts';

const TAG = '[brand-scraper]';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SKIP_DOMAINS = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'google.com', 'tiktok.com', 'linkedin.com',
  'pinterest.com', 'reddit.com',
];

const SKIP_EXTENSIONS = [
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.mp4', '.mp3', '.zip', '.rar', '.exe', '.dmg',
  '.woff', '.woff2', '.ttf', '.eot', '.ico',
];

const REMOVE_SELECTORS = [
  'nav', 'footer', 'header', 'script', 'style', 'noscript',
  'iframe', 'svg', 'form', 'button',
  '[class*="sidebar"]', '[class*="nav-"]', '[class*="nav_"]',
  '[class*="footer"]', '[class*="header"]',
  '[class*="breadcrumb"]', '[class*="search"]', '[class*="banner"]',
  '[class*="cookie"]', '[class*="popup"]', '[class*="modal"]',
  '[class*="social"]', '[class*="share"]', '[class*="menu"]',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[class*="toc"]', '[class*="widget"]',
];

const CHUNK_DURATION_MS = 2.5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RAW_HTML_BYTES = 5 * 1024 * 1024;
const MAX_CLEAN_HTML_BYTES = 1024 * 1024;
const PROGRESS_INTERVAL = 5;
const CHECKPOINT_INTERVAL = 5;

const JOB_TABLE = 'nest_brand_onboard_jobs';

export interface ScrapedImage {
  url: string;
  alt: string;
  pageUrl: string;
  pageTitle: string;
}

export interface CrawlState {
  visited: string[];
  toVisit: string[];
  seenImageUrls: string[];
  failed: number;
  totalPagesScraped: number;
  chunkIndex: number;
}

export interface ScrapeResult {
  markdown: string;
  images: ScrapedImage[];
  pagesScrapedThisChunk: number;
  totalPagesVisited: number;
  totalPagesScraped: number;
  totalPagesFailed: number;
  needsResume: boolean;
  resumeState?: CrawlState;
}

export interface ScrapeProgress {
  pagesFound: number;
  pagesScraped: number;
}

function normaliseDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normaliseUrl(href: string, baseUrl: string): string | null {
  try {
    const u = new URL(href, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const clean = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    return clean || u.origin;
  } catch {
    return null;
  }
}

function shouldSkipUrl(url: string, domain: string): boolean {
  const lower = url.toLowerCase();
  if (SKIP_DOMAINS.some((d) => lower.includes(d))) return true;
  if (SKIP_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  if (lower.includes('mailto:') || lower.includes('tel:')) return true;
  const urlDomain = normaliseDomain(url);
  if (urlDomain && urlDomain !== domain) return true;
  return false;
}

function extractLinks(doc: Document, baseUrl: string, domain: string): Set<string> {
  const out = new Set<string>();
  let totalAnchors = 0;
  let skipped = 0;
  try {
    const anchors = doc.querySelectorAll('a[href]');
    totalAnchors = anchors.length;
    for (const a of anchors) {
      const href = (a as Element).getAttribute('href');
      if (!href) continue;
      const normalised = normaliseUrl(href, baseUrl);
      if (normalised && !shouldSkipUrl(normalised, domain)) {
        out.add(normalised);
      } else {
        skipped++;
      }
    }
  } catch { /* ignore parse errors */ }
  console.log(`${TAG}   Links: ${totalAnchors} anchors found, ${out.size} internal kept, ${skipped} skipped`);
  return out;
}

function removeNoise(doc: Document): void {
  let removed = 0;
  for (const selector of REMOVE_SELECTORS) {
    try {
      const els = doc.querySelectorAll(selector);
      for (const el of els) {
        (el as Element).remove();
        removed++;
      }
    } catch { /* some selectors may not be supported */ }
  }
  console.log(`${TAG}   Noise removal: stripped ${removed} elements`);
}

const JUNK_IMAGE_PATTERNS = [
  'favicon', 'icon', 'logo', 'pixel', 'tracking', 'badge', 'spacer',
  'spinner', 'loader', 'arrow', 'chevron', 'caret', 'close', 'hamburger',
  'avatar-placeholder', 'blank.', '1x1', 'transparent.',
  'data:image/', 'base64,',
  'googletagmanager', 'facebook.com/tr', 'analytics',
];

const JUNK_IMAGE_EXTENSIONS = ['.svg', '.ico', '.gif'];

function isContentImage(src: string): boolean {
  const lower = src.toLowerCase();
  if (JUNK_IMAGE_PATTERNS.some(p => lower.includes(p))) return false;
  if (JUNK_IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) return false;
  if (!lower.startsWith('http')) return false;
  return true;
}

function resolveImgSrc(src: string, baseUrl: string): string | null {
  try {
    const u = new URL(src, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

function getBestImgSrc(node: any): string {
  const src = node.getAttribute?.('src') || '';
  const dataSrc = node.getAttribute?.('data-src') || '';
  const dataLazySrc = node.getAttribute?.('data-lazy-src') || '';
  const dataOriginal = node.getAttribute?.('data-original') || '';
  return dataSrc || dataLazySrc || dataOriginal || src;
}

function extractFirstSrcsetUrl(srcset: string): string {
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0] || '';
  return first;
}

function extractAllImages(
  doc: Document,
  pageUrl: string,
  pageTitle: string,
): ScrapedImage[] {
  const images: ScrapedImage[] = [];
  const seen = new Set<string>();

  const imgEls = doc.querySelectorAll('img');
  for (const node of imgEls) {
    const el = node as unknown as Element;
    let src = getBestImgSrc(el);
    if (!src) {
      const srcset = el.getAttribute?.('srcset') || '';
      if (srcset) src = extractFirstSrcsetUrl(srcset);
    }
    if (!src) continue;
    const resolved = resolveImgSrc(src, pageUrl);
    if (!resolved || !isContentImage(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    const alt = el.getAttribute?.('alt')?.trim() || '';
    images.push({ url: resolved, alt, pageUrl, pageTitle });
  }

  const sourceEls = doc.querySelectorAll('picture source[srcset]');
  for (const node of sourceEls) {
    const el = node as unknown as Element;
    const srcset = el.getAttribute?.('srcset') || '';
    const src = extractFirstSrcsetUrl(srcset);
    if (!src) continue;
    const resolved = resolveImgSrc(src, pageUrl);
    if (!resolved || !isContentImage(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    const parentPicture = el.parentElement;
    const siblingImg = parentPicture?.querySelector?.('img');
    const alt = (siblingImg as unknown as Element)?.getAttribute?.('alt')?.trim() || '';
    images.push({ url: resolved, alt, pageUrl, pageTitle });
  }

  return images;
}

function htmlToMarkdown(
  el: Element,
  imageCollector?: { images: ScrapedImage[]; pageUrl: string; pageTitle: string },
): string {
  const lines: string[] = [];
  const seenUrls = new Set<string>();

  function walk(node: any): string {
    if (node.nodeType === 3) {
      return (node.textContent || '').replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';

    const tag = (node.tagName || '').toLowerCase();
    const children = Array.from(node.childNodes || []).map(walk).join('');

    switch (tag) {
      case 'h1': return `\n# ${children.trim()}\n`;
      case 'h2': return `\n## ${children.trim()}\n`;
      case 'h3': return `\n### ${children.trim()}\n`;
      case 'h4': return `\n#### ${children.trim()}\n`;
      case 'h5': return `\n##### ${children.trim()}\n`;
      case 'h6': return `\n###### ${children.trim()}\n`;
      case 'p': return `\n${children.trim()}\n`;
      case 'br': return '\n';
      case 'hr': return '\n---\n';
      case 'strong':
      case 'b': return `**${children.trim()}**`;
      case 'em':
      case 'i': return `*${children.trim()}*`;
      case 'a': {
        const href = node.getAttribute?.('href') || '';
        const text = children.trim();
        if (!text) return '';
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          return `[${text}](${href})`;
        }
        return text;
      }
      case 'ul':
      case 'ol': return `\n${children}\n`;
      case 'li': return `- ${children.trim()}\n`;
      case 'blockquote': return `\n> ${children.trim()}\n`;
      case 'code': return `\`${children.trim()}\``;
      case 'pre': return `\n\`\`\`\n${children.trim()}\n\`\`\`\n`;
      case 'table':
      case 'thead':
      case 'tbody':
      case 'tfoot': return children;
      case 'tr': return `| ${children.trim()} |\n`;
      case 'th':
      case 'td': return ` ${children.trim()} |`;
      case 'img': {
        const alt = node.getAttribute?.('alt') || '';
        const src = getBestImgSrc(node);
        if (imageCollector && src) {
          const resolved = resolveImgSrc(src, imageCollector.pageUrl);
          if (resolved && isContentImage(resolved) && !seenUrls.has(resolved)) {
            seenUrls.add(resolved);
            imageCollector.images.push({
              url: resolved,
              alt: alt.trim(),
              pageUrl: imageCollector.pageUrl,
              pageTitle: imageCollector.pageTitle,
            });
          }
        }
        return alt ? `[Image: ${alt}]` : '';
      }
      case 'div':
      case 'section':
      case 'article':
      case 'main':
      case 'span':
      case 'figure':
      case 'figcaption':
        return children;
      default:
        return children;
    }
  }

  lines.push(walk(el));

  return lines
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^\s+/, '')
    .trim();
}

function stripHeavyContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');
}

async function fetchPage(url: string): Promise<{ html: string | null; status: number; elapsed: number; size: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    const elapsed = Date.now() - start;
    if (!resp.ok) {
      return { html: null, status: resp.status, elapsed, size: 0 };
    }
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      console.log(`${TAG}   Skipped non-HTML content-type: ${ct}`);
      return { html: null, status: resp.status, elapsed, size: 0 };
    }
    const rawHtml = await resp.text();
    if (rawHtml.length > MAX_RAW_HTML_BYTES) {
      console.log(`${TAG}   Skipped oversized page: ${(rawHtml.length / 1024 / 1024).toFixed(1)}MB`);
      return { html: null, status: resp.status, elapsed: Date.now() - start, size: rawHtml.length };
    }
    let html = stripHeavyContent(rawHtml);
    if (html.length > MAX_CLEAN_HTML_BYTES) {
      html = html.substring(0, MAX_CLEAN_HTML_BYTES);
    }
    return { html, status: resp.status, elapsed, size: rawHtml.length };
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`${TAG}   Fetch error: ${(err as Error).message} (${elapsed}ms)`);
    return { html: null, status: 0, elapsed, size: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

async function updateJobProgress(
  jobId: string,
  pagesFound: number,
  pagesScraped: number,
): Promise<void> {
  try {
    const supabase = getAdminClient();
    await supabase
      .from(JOB_TABLE)
      .update({ pages_found: pagesFound, pages_scraped: pagesScraped, updated_at: new Date().toISOString() })
      .eq('id', jobId);
  } catch (e) {
    console.error(`${TAG} progress update failed:`, (e as Error).message);
  }
}

export type CheckpointCallback = (state: CrawlState, chunkMarkdown: string, chunkImages: ScrapedImage[]) => Promise<void>;

export async function scrapeWebsite(
  websiteUrl: string,
  businessName: string,
  jobId: string,
  resumeState?: CrawlState,
  onCheckpoint?: CheckpointCallback,
): Promise<ScrapeResult> {
  const domain = normaliseDomain(websiteUrl);
  if (!domain) throw new Error('Invalid website URL');

  const chunkIndex = resumeState?.chunkIndex ?? 0;
  const isResume = !!resumeState;

  console.log(`${TAG} ════════════════════════════════════════════`);
  console.log(`${TAG} ${isResume ? 'Resuming' : 'Starting'} scrape (chunk ${chunkIndex})`);
  console.log(`${TAG}   Business: ${businessName}`);
  console.log(`${TAG}   URL:      ${websiteUrl}`);
  console.log(`${TAG}   Domain:   ${domain}`);
  console.log(`${TAG}   Job ID:   ${jobId}`);
  console.log(`${TAG}   Chunk:    ${CHUNK_DURATION_MS / 1000}s budget`);
  if (isResume) {
    console.log(`${TAG}   Resumed:  ${resumeState!.visited.length} visited, ${resumeState!.toVisit.length} queued`);
  }
  console.log(`${TAG} ════════════════════════════════════════════`);

  const startUrl = websiteUrl.replace(/\/+$/, '');
  const visited = new Set<string>(resumeState?.visited ?? []);
  const toVisit = new Set<string>(resumeState?.toVisit ?? [startUrl]);
  const seenImageUrls = new Set<string>(resumeState?.seenImageUrls ?? []);
  let failed = resumeState?.failed ?? 0;
  let previousPagesScraped = resumeState?.totalPagesScraped ?? 0;

  const chunkContent: string[] = [];
  const chunkImages: ScrapedImage[] = [];
  const startTime = Date.now();

  while (toVisit.size > 0) {
    const elapsed = Date.now() - startTime;
    if (elapsed > CHUNK_DURATION_MS) {
      console.log(`${TAG} ⏸ Chunk time limit reached (${(elapsed / 1000).toFixed(1)}s) — will resume`);
      break;
    }

    const url = toVisit.values().next().value!;
    toVisit.delete(url);
    if (visited.has(url)) continue;
    visited.add(url);

    console.log(`${TAG} ────────────────────────────────────────`);
    console.log(`${TAG} [${visited.size}/${visited.size + toVisit.size}] Fetching: ${url}`);

    const { html, status, elapsed: fetchMs, size: htmlSize } = await fetchPage(url);

    if (!html) {
      console.log(`${TAG}   ✗ Failed: HTTP ${status}, ${fetchMs}ms`);
      failed++;
      continue;
    }

    console.log(`${TAG}   ✓ HTTP ${status}, ${fetchMs}ms, ${(htmlSize / 1024).toFixed(1)}KB HTML`);

    try {
      const parseStart = Date.now();
      const doc = new DOMParser().parseFromString(html, 'text/html') as unknown as Document;
      console.log(`${TAG}   DOM parsed in ${Date.now() - parseStart}ms`);

      const newLinks = extractLinks(doc, url, domain);
      let newCount = 0;
      for (const link of newLinks) {
        if (!visited.has(link)) {
          toVisit.add(link);
          newCount++;
        }
      }
      console.log(`${TAG}   Queue: +${newCount} new URLs, ${toVisit.size} remaining`);

      const pageTitle = doc.querySelector('title')?.textContent?.trim() || '';

      const fullBodyImages = extractAllImages(doc, url, pageTitle);
      for (const img of fullBodyImages) {
        if (!seenImageUrls.has(img.url)) {
          seenImageUrls.add(img.url);
          chunkImages.push(img);
        }
      }
      if (fullBodyImages.length > 0) {
        console.log(`${TAG}   Images: ${fullBodyImages.length} content images found (full page)`);
      }

      removeNoise(doc);

      const mainEl =
        doc.querySelector('article') ||
        doc.querySelector('main') ||
        doc.querySelector('[class*="content"]') ||
        doc.querySelector('body');

      const selector = mainEl ? (
        doc.querySelector('article') ? 'article' :
        doc.querySelector('main') ? 'main' :
        doc.querySelector('[class*="content"]') ? '[class*="content"]' : 'body'
      ) : 'none';

      if (mainEl) {
        const md = htmlToMarkdown(mainEl as unknown as Element);
        console.log(`${TAG}   Content: extracted via <${selector}>, ${md.length} chars markdown`);
        if (md.length > 100) {
          chunkContent.push(`\n\n---\n# ${url}\n\n${md}`);
          console.log(`${TAG}   ✓ Page accepted (${md.length} chars)`);
        } else {
          console.log(`${TAG}   ✗ Page rejected: too short (${md.length} chars, need >100)`);
        }
      } else {
        console.log(`${TAG}   ✗ No content element found`);
      }
    } catch (e) {
      console.error(`${TAG}   ✗ Parse error: ${(e as Error).message}`);
      failed++;
    }

    const totalScraped = previousPagesScraped + chunkContent.length;
    if (totalScraped % PROGRESS_INTERVAL === 0 && chunkContent.length > 0) {
      await updateJobProgress(jobId, visited.size + toVisit.size, totalScraped);
      console.log(`${TAG}   → Progress saved to DB`);
    }

    if (onCheckpoint && chunkContent.length > 0 && chunkContent.length % CHECKPOINT_INTERVAL === 0) {
      const cpState: CrawlState = {
        visited: Array.from(visited),
        toVisit: Array.from(toVisit),
        seenImageUrls: Array.from(seenImageUrls),
        failed,
        totalPagesScraped: totalScraped,
        chunkIndex: (resumeState?.chunkIndex ?? 0),
      };
      await onCheckpoint(cpState, chunkContent.join(''), chunkImages);
      chunkContent.length = 0;
      chunkImages.length = 0;
      console.log(`${TAG}   → Checkpoint saved (${totalScraped} pages so far)`);
    }
  }

  const totalPagesScraped = previousPagesScraped + chunkContent.length;
  const needsResume = toVisit.size > 0;

  await updateJobProgress(jobId, visited.size + toVisit.size, totalPagesScraped);

  const chunkElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const chunkMarkdown = chunkContent.join('');

  console.log(`${TAG} ════════════════════════════════════════════`);
  console.log(`${TAG} Chunk ${chunkIndex} ${needsResume ? 'paused' : 'finished'}`);
  console.log(`${TAG}   Chunk duration:   ${chunkElapsed}s`);
  console.log(`${TAG}   This chunk:       ${chunkContent.length} pages scraped, ${chunkImages.length} images`);
  console.log(`${TAG}   Total visited:    ${visited.size}`);
  console.log(`${TAG}   Total scraped:    ${totalPagesScraped}`);
  console.log(`${TAG}   Total failed:     ${failed}`);
  console.log(`${TAG}   Remaining queue:  ${toVisit.size}`);
  console.log(`${TAG}   Needs resume:     ${needsResume}`);
  console.log(`${TAG} ════════════════════════════════════════════`);

  const result: ScrapeResult = {
    markdown: chunkMarkdown,
    images: chunkImages,
    pagesScrapedThisChunk: chunkContent.length,
    totalPagesVisited: visited.size,
    totalPagesScraped,
    totalPagesFailed: failed,
    needsResume,
  };

  if (needsResume) {
    result.resumeState = {
      visited: Array.from(visited),
      toVisit: Array.from(toVisit),
      seenImageUrls: Array.from(seenImageUrls),
      failed,
      totalPagesScraped,
      chunkIndex: chunkIndex + 1,
    };
  }

  return result;
}
