const http = require('http');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const PORT = process.env.PORT || 3000;

// Locate Google Chrome or Microsoft Edge
function getBrowserPath() {
  const paths = [
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Neither Google Chrome nor Microsoft Edge was found on this system.');
}

// Helper: Extract comments from a loaded post page using multiple robust methods
async function extractCommentsFromCurrentPage(page, postAuthor = '', maxComments = 25) {
  try {
    await page.waitForSelector('a[href*="/c/"], time, span[dir="auto"]', { timeout: 8000 });
  } catch (e) {}

  await new Promise(r => setTimeout(r, 2000));

  return await page.evaluate((authorToExclude, max) => {
    const list = [];
    const seen = new Set();
    const cleanAuthorToExclude = (authorToExclude || '').toLowerCase().trim();

    // Strategy 1: Find permalink anchors: a[href*="/c/"] (Primary desktop Instagram comment anchors)
    const commentAnchors = Array.from(document.querySelectorAll('a[href*="/c/"]'));
    for (const cl of commentAnchors) {
      let container = cl;
      let foundAuthor = null;
      let foundText = null;
      let foundAvatar = '';
      let timeText = cl.innerText.trim();

      // Climb up 8 ancestor levels to capture author and comment text
      for (let i = 0; i < 8; i++) {
        if (!container.parentElement) break;
        container = container.parentElement;

        const authorAnchor = container.querySelector(
          'a[role="link"][href^="/"]:not([href*="/c/"]), a[href^="/"]:not([href*="/c/"]):not([href*="/p/"]):not([href*="/reel/"]):not([href*="/reels/"]):not([href*="/explore/"])'
        );

        if (authorAnchor) {
          const author = authorAnchor.innerText.trim();
          const authorLower = author.toLowerCase();

          if (
            author &&
            authorLower !== cleanAuthorToExclude &&
            authorLower !== 'original audio' &&
            authorLower !== 'terms of use' &&
            authorLower !== 'privacy policy' &&
            !authorLower.includes('verified')
          ) {
            foundAuthor = author;

            const textSpans = Array.from(container.querySelectorAll('span[dir="auto"], span'))
              .filter(s => !s.closest('a') && !s.closest('time') && !s.closest('button'))
              .map(s => s.innerText.trim())
              .filter(t => 
                t &&
                t !== author &&
                t !== timeText &&
                !t.includes('Like') &&
                !t.includes('Reply') &&
                !t.match(/^\d+[smhdw]$/) &&
                !t.toLowerCase().includes('translation') &&
                !t.toLowerCase().includes('translated') &&
                !t.toLowerCase().includes('view replies') &&
                !t.toLowerCase().includes('hide replies')
              );

            if (textSpans.length > 0) {
              foundText = textSpans[0];
            }

            const img = container.querySelector('img[alt*="profile"], img[alt*="avatar"], img[crossorigin="anonymous"]');
            if (img && img.src) foundAvatar = img.src;

            if (foundAuthor && foundText) break;
          }
        }
      }

      if (foundAuthor && foundText) {
        const key = foundAuthor.toLowerCase() + ':' + foundText;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({
            author: foundAuthor,
            author_url: `https://www.instagram.com/${foundAuthor}/`,
            text: foundText,
            time: timeText,
            comment_url: cl.href,
            avatar: foundAvatar
          });
          if (list.length >= max) return list;
        }
      }
    }

    // Strategy 2: Scan HTML5 <time> elements (Secondary fallback)
    if (list.length === 0) {
      const times = Array.from(document.querySelectorAll('time'));
      for (const t of times) {
        let container = t;
        let foundAuthor = null;
        let foundText = null;

        for (let i = 0; i < 8; i++) {
          if (!container.parentElement) break;
          container = container.parentElement;

          const authorAnchor = container.querySelector('a[href^="/"]:not([href*="/p/"]):not([href*="/reel/"]):not([href*="/explore/"])');
          if (authorAnchor) {
            const author = authorAnchor.innerText.trim();
            if (author && author.toLowerCase() !== cleanAuthorToExclude) {
              foundAuthor = author;
              const textSpans = Array.from(container.querySelectorAll('span[dir="auto"], span'))
                .filter(s => !s.closest('a') && !s.closest('time') && !s.closest('button'))
                .map(s => s.innerText.trim())
                .filter(txt => txt && txt !== author && txt !== t.innerText.trim() && !txt.includes('Like') && !txt.includes('Reply') && !txt.match(/^\d+[smhdw]$/));

              if (textSpans.length > 0) {
                foundText = textSpans[0];
                break;
              }
            }
          }
        }

        if (foundAuthor && foundText) {
          const key = foundAuthor.toLowerCase() + ':' + foundText;
          if (!seen.has(key)) {
            seen.add(key);
            list.push({
              author: foundAuthor,
              author_url: `https://www.instagram.com/${foundAuthor}/`,
              text: foundText,
              time: t.innerText.trim(),
              comment_url: '',
              avatar: ''
            });
            if (list.length >= max) return list;
          }
        }
      }
    }

    return list;
  }, postAuthor, maxComments);
}

// Browser-based Scraper Engine
async function scrapeInstagram({ type, input, count = 4, session = '' }) {
  const browserPath = getBrowserPath();
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Capture comments from background network responses
    const capturedCommentsMap = new Map();
    page.on('response', async (res) => {
      const url = res.url();
      if (url.includes('/graphql') || url.includes('/comments') || url.includes('comment')) {
        try {
          const ct = res.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const data = await res.json();
            const edges = data?.data?.xdt_api__v1__media__comments__connection?.edges ||
                          data?.data?.shortcode_media?.edge_media_to_parent_comment?.edges ||
                          data?.comments;
            if (Array.isArray(edges)) {
              const parsed = [];
              for (const edge of edges) {
                const node = edge.node || edge;
                const author = node?.user?.username || node?.owner?.username || '';
                const text = node?.text || '';
                if (author && text) parsed.push({ author, text });
              }
              if (parsed.length > 0) {
                capturedCommentsMap.set(page.url(), parsed);
              }
            }
          }
        } catch (e) {}
      }
    });

    // Attach Session Cookies if provided
    let hasCustomSession = false;
    if (session && session.trim()) {
      const sessionVal = session.replace(/^sessionid=/, '').trim();
      const cookies = [
        { name: 'sessionid', value: sessionVal, domain: '.instagram.com', path: '/' }
      ];
      if (sessionVal.includes('%3A')) {
        const dsUserId = sessionVal.split('%3A')[0];
        cookies.push({ name: 'ds_user_id', value: dsUserId, domain: '.instagram.com', path: '/' });
      }
      await page.setCookie(...cookies);
      hasCustomSession = true;
    }

    const cleanedInput = input.trim();
    const isDirectPost = cleanedInput.includes('/p/') || cleanedInput.includes('/reel/');

    // Helper to safely navigate with auto-fallback if an expired/invalid session cookie causes a login redirect
    async function safeNavigate(url, waitMode = 'domcontentloaded') {
      console.log(`[Scraper] Navigating to: ${url}`);
      await page.goto(url, { waitUntil: waitMode, timeout: 35000 });
      await new Promise(r => setTimeout(r, 2500));

      // If redirected to login page due to invalid session cookie, recover by clearing cookies and browsing publicly
      if (page.url() === 'https://www.instagram.com/' || page.url().includes('/accounts/login')) {
        if (hasCustomSession) {
          console.warn('[Scraper] Session cookie invalid or expired. Auto-recovering in anonymous public viewer mode...');
          const cdp = await page.target().createCDPSession();
          await cdp.send('Network.clearBrowserCookies');
          hasCustomSession = false;
          await page.goto(url, { waitUntil: waitMode, timeout: 35000 });
          await new Promise(r => setTimeout(r, 2500));
        }
      }
    }

    // Case 1: Direct single post URL (for comments or post info)
    if (isDirectPost) {
      let postUrl = cleanedInput;
      if (!postUrl.startsWith('http')) postUrl = 'https://' + postUrl;

      const match = postUrl.match(/\/(p|reel)\/([^\/\?]+)/);
      const shortcode = match ? match[2] : 'post';
      const cleanPostUrl = `https://www.instagram.com/${match ? match[1] : 'p'}/${shortcode}/`;

      await safeNavigate(cleanPostUrl, 'domcontentloaded');

      const domComments = await extractCommentsFromCurrentPage(page, '', 30);
      const netComments = capturedCommentsMap.get(page.url()) || [];
      const comments = domComments.length > 0 ? domComments : netComments;

      const postDetails = await page.evaluate(() => {
        const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
        const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content');
        const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
        const img = document.querySelector('article img, div[role="dialog"] img, img[style*="object-fit"]');
        const descEl = document.querySelector('h1, span[dir="auto"]');

        return {
          thumbnail_src: ogImage || (img ? img.src : ''),
          description: ogDesc || (descEl ? descEl.innerText.trim() : '') || ogTitle || ''
        };
      });

      console.log(`[Scraper] Direct post #${shortcode}: Extracted ${comments.length} comments.`);

      return {
        count: 1,
        collector: [{
          id: shortcode,
          shortcode,
          type: cleanPostUrl.includes('/reel/') ? 'reel' : 'post',
          url: cleanPostUrl,
          thumbnail_src: postDetails.thumbnail_src,
          description: postDetails.description,
          comments: comments,
          comments_count: comments.length
        }]
      };
    }

    // Case 2: Target is a User Profile or Hashtag
    let targetUrl = cleanedInput;
    let targetUsername = '';
    if (!targetUrl.startsWith('http')) {
      if (type === 'hashtag') {
        const tag = targetUrl.replace(/^#/, '');
        targetUrl = `https://www.instagram.com/explore/tags/${tag}/`;
      } else {
        targetUsername = targetUrl.replace(/^@/, '');
        targetUrl = `https://www.instagram.com/${targetUsername}/`;
      }
    } else {
      const uMatch = targetUrl.match(/instagram\.com\/([^\/\?]+)/);
      if (uMatch) targetUsername = uMatch[1];
    }

    await safeNavigate(targetUrl, 'domcontentloaded');

    try {
      await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 12000 });
    } catch (e) {}

    await page.evaluate(() => window.scrollBy(0, 500));
    await new Promise(r => setTimeout(r, 2000));

    // Extract post items from profile grid with CLEAN CANONICAL URLs
    const posts = await page.evaluate((maxCount) => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
      const seen = new Set();
      const results = [];

      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/(p|reel)\/([^\/\?]+)/);
        if (!match) continue;
        const kind = match[1];
        const code = match[2];
        if (seen.has(code)) continue;
        seen.add(code);

        const img = a.querySelector('img');
        results.push({
          id: code,
          shortcode: code,
          type: kind === 'reel' ? 'reel' : 'post',
          url: `https://www.instagram.com/${kind}/${code}/`,
          thumbnail_src: img ? img.src : '',
          display_url: img ? img.src : '',
          description: img ? (img.getAttribute('alt') || '') : '',
          is_video: kind === 'reel',
          comments: [],
          comments_count: 0
        });

        if (results.length >= maxCount) break;
      }
      return results;
    }, count);

    console.log(`[Scraper] Retrieved ${posts.length} post previews from profile.`);

    // If "Post Comments" was requested, fetch comments per post
    if (type === 'comments' && posts.length > 0) {
      console.log(`[Scraper] Fetching structured comments for ${posts.length} posts...`);
      for (const p of posts) {
        try {
          console.log(`[Scraper] Loading comments for post: ${p.shortcode} (${p.url})`);
          await safeNavigate(p.url, 'domcontentloaded');

          const domComments = await extractCommentsFromCurrentPage(page, targetUsername, 20);
          const netComments = capturedCommentsMap.get(page.url()) || [];
          p.comments = domComments.length > 0 ? domComments : netComments;
          p.comments_count = p.comments.length;
          console.log(`[Scraper] Post #${p.shortcode}: Extracted ${p.comments.length} comments.`);
        } catch (err) {
          console.log(`[Scraper] Could not fetch comments for ${p.shortcode}: ${err.message}`);
          p.comments = [];
          p.comments_count = 0;
        }
      }
    }

    return {
      collector: posts,
      count: posts.length
    };

  } finally {
    await browser.close();
  }
}

// Embedded Single-Page Frontend
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Instagram OSINT Intelligence Dashboard</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #131c2e;
      --card-border: #223049;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --accent: #ec4899;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 32px 16px;
      line-height: 1.5;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
    }
    header {
      text-align: center;
      margin-bottom: 32px;
    }
    .badge-top {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.3);
      color: #a5b4fc;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    header h1 {
      font-size: 32px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #f43f5e 0%, #ec4899 35%, #8b5cf6 70%, #3b82f6 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }
    header p {
      color: var(--text-muted);
      font-size: 15px;
      max-width: 580px;
      margin: 0 auto;
    }
    .panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 28px;
      box-shadow: 0 12px 35px rgba(0, 0, 0, 0.4);
      margin-bottom: 28px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 18px;
      margin-bottom: 18px;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    label {
      font-size: 13px;
      font-weight: 600;
      color: #cbd5e1;
      display: flex;
      justify-content: space-between;
    }
    input, select {
      background: #090d16;
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 12px 14px;
      color: var(--text);
      font-size: 14px;
      outline: none;
      transition: all 0.2s;
    }
    input:focus, select:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }
    .help-hint {
      font-size: 11px;
      color: #64748b;
    }
    .btn {
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      color: white;
      border: none;
      border-radius: 10px;
      padding: 14px 24px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: all 0.2s;
      box-shadow: 0 4px 15px rgba(79, 70, 229, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn:hover {
      box-shadow: 0 6px 20px rgba(79, 70, 229, 0.5);
      transform: translateY(-1px);
    }
    .btn:disabled {
      background: #334155;
      cursor: not-allowed;
      box-shadow: none;
      transform: none;
      opacity: 0.7;
    }
    .status-box {
      display: none;
      padding: 14px 18px;
      border-radius: 12px;
      margin-bottom: 24px;
      font-size: 14px;
      align-items: center;
      gap: 10px;
    }
    .status-box.error {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
    }
    .status-box.info {
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #c7d2fe;
    }

    /* Results Header & OSINT Banner */
    .osint-banner {
      background: linear-gradient(135deg, #1e1b4b 0%, #172554 100%);
      border: 1px solid #3730a3;
      border-radius: 14px;
      padding: 20px 24px;
      margin-bottom: 22px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .target-info {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .target-avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: linear-gradient(135deg, #ec4899, #6366f1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 700;
      color: white;
      border: 2px solid #818cf8;
    }
    .target-meta h3 {
      font-size: 18px;
      font-weight: 700;
    }
    .target-meta p {
      font-size: 13px;
      color: #cbd5e1;
    }
    .export-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .action-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #f1f5f9;
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .action-btn:hover {
      background: rgba(255, 255, 255, 0.16);
      border-color: rgba(255, 255, 255, 0.3);
    }

    /* Filter & Search Bar */
    .filter-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .search-input-wrap {
      flex: 1;
      min-width: 260px;
      position: relative;
    }
    .search-input-wrap input {
      width: 100%;
      padding-left: 36px;
    }
    .search-icon {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: #64748b;
      font-size: 14px;
    }

    /* Post and Structured Comments Layout */
    .posts-container {
      display: flex;
      flex-direction: column;
      gap: 26px;
    }
    .post-item-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
    }
    .post-main-row {
      display: flex;
      flex-wrap: wrap;
      border-bottom: 1px solid var(--card-border);
    }
    .post-media-col {
      width: 320px;
      min-height: 260px;
      background: #020617;
      position: relative;
      flex-shrink: 0;
    }
    .post-media-col img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .post-badge {
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      font-size: 11px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 8px;
    }
    .post-content-col {
      flex: 1;
      min-width: 300px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .post-meta-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
    }
    .post-code {
      font-family: monospace;
      color: #38bdf8;
      font-weight: 600;
      cursor: pointer;
    }
    .post-code:hover { text-decoration: underline; }
    .post-caption {
      font-size: 14px;
      color: #cbd5e1;
      line-height: 1.6;
    }
    .hashtag {
      color: #ec4899;
      font-weight: 500;
    }
    .post-links {
      margin-top: auto;
      display: flex;
      gap: 12px;
    }
    .post-link-btn {
      font-size: 13px;
      color: #818cf8;
      text-decoration: none;
      font-weight: 600;
    }
    .post-link-btn:hover { text-decoration: underline; }

    /* Structured Comments Section */
    .comments-section {
      padding: 20px;
      background: rgba(10, 15, 27, 0.7);
    }
    .comments-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .comments-title {
      font-size: 14px;
      font-weight: 700;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .comments-pill {
      background: #312e81;
      color: #c7d2fe;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
    }
    .comments-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 280px;
      overflow-y: auto;
      padding-right: 6px;
    }
    .comment-bubble {
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 10px;
      padding: 10px 14px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .comment-avatar {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: #475569;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      color: #f1f5f9;
      flex-shrink: 0;
    }
    .comment-body {
      flex: 1;
    }
    .comment-author {
      font-size: 13px;
      font-weight: 600;
      color: #38bdf8;
      margin-bottom: 2px;
    }
    .comment-text {
      font-size: 13px;
      color: #e2e8f0;
      line-height: 1.4;
      word-break: break-word;
    }
    .no-comments-msg {
      color: #64748b;
      font-size: 13px;
      font-style: italic;
      padding: 8px 0;
    }

    /* Raw JSON view */
    .raw-json {
      background: #020617;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: #38bdf8;
      max-height: 420px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin-top: 20px;
      display: none;
    }
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 0.8s ease-in-out infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge-top">🛡️ Active OSINT Engine</div>
      <h1>Instagram Intelligence Scraper</h1>
      <p>Live post, media, and per-post comment extraction</p>
    </header>

    <div class="panel">
      <form id="scrapeForm">
        <div class="grid">
          <div class="form-group">
            <label for="type">Scrape Type</label>
            <select id="type" name="type">
              <option value="user">User Profile Posts</option>
              <option value="comments" selected>Post Comments (Per Post Wise)</option>
              <option value="hashtag">Hashtag Posts</option>
            </select>
          </div>

          <div class="form-group">
            <label for="input">Target Account or Post URL</label>
            <input type="text" id="input" name="input" placeholder="e.g. cristiano or https://www.instagram.com/p/..." required>
            <span class="help-hint">Enter username (fetches latest posts + comments) or direct post URL</span>
          </div>

          <div class="form-group">
            <label for="count">Post Count Limit</label>
            <input type="number" id="count" name="count" value="4" min="1" max="20">
          </div>
        </div>

        <div class="form-group" style="margin-bottom: 22px;">
          <label for="session">
            <span>Instagram Session Cookie (sessionid)</span>
            <span style="font-size:11px; font-weight:normal; color:#818cf8;">Active session required</span>
          </label>
          <input type="text" id="session" name="session" placeholder="Paste your active session cookie value here">
          <span class="help-hint">Get from browser DevTools &rarr; Application &rarr; Cookies &rarr; 'sessionid'</span>
        </div>

        <button type="submit" id="submitBtn" class="btn">
          <span id="btnText">Launch Scraper</span>
        </button>
      </form>
    </div>

    <div id="statusBox" class="status-box"></div>

    <div id="resultsSection" style="display:none;">
      <!-- OSINT Target Info Banner -->
      <div class="osint-banner">
        <div class="target-info">
          <div id="targetAvatar" class="target-avatar">IG</div>
          <div class="target-meta">
            <h3 id="targetHeading">@target</h3>
            <p id="targetSubtext">Extraction complete</p>
          </div>
        </div>
        <div class="export-actions">
          <button id="downloadJsonBtn" class="action-btn">📥 Export JSON</button>
          <button id="downloadCsvBtn" class="action-btn">📊 Export CSV</button>
          <button id="toggleJsonBtn" class="action-btn">Code View</button>
        </div>
      </div>

      <!-- Filter & Search Toolbar -->
      <div class="filter-bar">
        <div class="search-input-wrap">
          <span class="search-icon">🔍</span>
          <input type="text" id="searchInput" placeholder="Filter posts and comments by keyword...">
        </div>
      </div>

      <!-- Structured Posts & Comments List -->
      <div id="postsContainer" class="posts-container"></div>
      
      <!-- Collapsible Raw Data Block -->
      <pre id="rawJson" class="raw-json"></pre>
    </div>
  </div>

  <script>
    const form = document.getElementById('scrapeForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = document.getElementById('btnText');
    const statusBox = document.getElementById('statusBox');
    const resultsSection = document.getElementById('resultsSection');
    const postsContainer = document.getElementById('postsContainer');
    const rawJson = document.getElementById('rawJson');
    const toggleJsonBtn = document.getElementById('toggleJsonBtn');
    const downloadJsonBtn = document.getElementById('downloadJsonBtn');
    const downloadCsvBtn = document.getElementById('downloadCsvBtn');
    const searchInput = document.getElementById('searchInput');
    const targetHeading = document.getElementById('targetHeading');
    const targetSubtext = document.getElementById('targetSubtext');
    const targetAvatar = document.getElementById('targetAvatar');

    let allScrapedItems = [];
    let currentTargetName = '';
    let showJson = false;

    toggleJsonBtn.addEventListener('click', () => {
      showJson = !showJson;
      rawJson.style.display = showJson ? 'block' : 'none';
      toggleJsonBtn.textContent = showJson ? 'Hide Code' : 'Code View';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const target = document.getElementById('input').value.trim();
      const type = document.getElementById('type').value;
      const count = parseInt(document.getElementById('count').value, 10) || 4;
      const session = document.getElementById('session').value.trim();

      currentTargetName = target;

      statusBox.style.display = 'flex';
      statusBox.className = 'status-box info';
      statusBox.innerHTML = '<span class="spinner"></span> <span>Scraping live posts and structured comments... (~15-25s)</span>';
      submitBtn.disabled = true;
      btnText.innerHTML = '<span class="spinner"></span> Scraping live...';
      resultsSection.style.display = 'none';
      postsContainer.innerHTML = '';
      rawJson.textContent = '';

      try {
        const res = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, input: target, count, session })
        });

        const data = await res.json();

        if (!data.success) {
          throw new Error(data.error || 'Failed to extract data.');
        }

        allScrapedItems = data.data.collector || [];

        statusBox.className = 'status-box info';
        statusBox.innerHTML = '✅ Successfully extracted ' + allScrapedItems.length + ' posts with structured comments.';

        targetHeading.textContent = target.startsWith('http') ? target : '@' + target;
        targetSubtext.textContent = allScrapedItems.length + ' posts analyzed • ' + new Date().toLocaleTimeString();
        targetAvatar.textContent = target.charAt(0).toUpperCase();

        renderPostsWithComments(allScrapedItems);

        rawJson.textContent = JSON.stringify(data.data, null, 2);
        resultsSection.style.display = 'block';

      } catch (err) {
        statusBox.className = 'status-box error';
        statusBox.innerHTML = '⚠️ <strong>Extraction Error:</strong> ' + err.message;
      } finally {
        submitBtn.disabled = false;
        btnText.textContent = 'Launch Scraper';
      }
    });

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      if (!q) {
        renderPostsWithComments(allScrapedItems);
        return;
      }
      const filtered = allScrapedItems.filter(p => {
        const caption = (p.description || '').toLowerCase();
        const code = (p.shortcode || '').toLowerCase();
        const commentsMatch = (p.comments || []).some(c => 
          (c.author || '').toLowerCase().includes(q) || (c.text || '').toLowerCase().includes(q)
        );
        return caption.includes(q) || code.includes(q) || commentsMatch;
      });
      renderPostsWithComments(filtered);
    });

    function renderPostsWithComments(posts) {
      postsContainer.innerHTML = '';
      if (!posts || posts.length === 0) {
        postsContainer.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted); background: var(--card-bg); border-radius: 16px; border: 1px dashed var(--card-border);">No posts or comments found.</div>';
        return;
      }

      posts.forEach((post, idx) => {
        const card = document.createElement('div');
        card.className = 'post-item-card';

        const imgSrc = post.thumbnail_src || post.display_url || '';
        const shortcode = post.shortcode || post.id || '';
        const postUrl = post.url || ('https://www.instagram.com/p/' + shortcode + '/');
        const isReel = post.is_video || post.type === 'reel';
        const comments = post.comments || [];
        const caption = escapeHtml(post.description || '').replace(/#([\\w_]+)/g, '<span class="hashtag">#$1</span>');

        // Render Comments List
        let commentsHtml = '';
        if (comments.length > 0) {
          commentsHtml = comments.map(c => \`
            <div class="comment-bubble">
              <div class="comment-avatar">\${(c.author || 'U').charAt(0).toUpperCase()}</div>
              <div class="comment-body">
                <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px;">
                  <a href="\${c.author_url || ('https://www.instagram.com/' + (c.author || '') + '/')}" target="_blank" rel="noopener" class="comment-author">@\${escapeHtml(c.author || 'anonymous')}</a>
                  <span style="font-size: 11px; color: #94a3b8; margin-left: 8px;">\${escapeHtml(c.time || '')}</span>
                </div>
                <div class="comment-text">\${escapeHtml(c.text || '')}</div>
                \${c.comment_url ? \`<div style="margin-top: 4px;"><a href="\${c.comment_url}" target="_blank" rel="noopener" style="font-size: 11px; color: #818cf8; text-decoration: none;">View on Instagram ↗</a></div>\` : ''}
              </div>
            </div>
          \`).join('');
        } else {
          commentsHtml = '<p class="no-comments-msg">No visible comments found on this post (comments may be disabled or limited).</p>';
        }

        card.innerHTML = \`
          <div class="post-main-row">
            <div class="post-media-col">
              \${imgSrc ? \`<img src="\${imgSrc}" loading="lazy" onerror="this.src='https://placehold.co/400x300/1e293b/white?text=Media+Preview'">\` : '<div style="padding:40px;color:#64748b;text-align:center;">No Image Preview</div>'}
              <span class="post-badge">\${isReel ? '🎬 Reel' : '📸 Post'}</span>
            </div>
            <div class="post-content-col">
              <div class="post-meta-top">
                <span class="post-code" title="Click to copy" onclick="navigator.clipboard.writeText('\${shortcode}')">
                  #\${shortcode} 📋
                </span>
                <span style="color:#94a3b8;font-size:12px;">Post #\${idx + 1}</span>
              </div>
              <div class="post-caption">\${caption || '<span style="color:#64748b;font-style:italic;">No caption provided</span>'}</div>
              <div class="post-links">
                <a href="\${postUrl}" target="_blank" rel="noopener" class="post-link-btn">View Post on Instagram ↗</a>
                <button class="action-btn" style="padding:4px 8px;font-size:11px;" onclick="navigator.clipboard.writeText('\${postUrl}'); alert('Post URL copied!');">Share Link</button>
              </div>
            </div>
          </div>

          <div class="comments-section">
            <div class="comments-header">
              <div class="comments-title">
                <span>💬 Comments on this Post</span>
                <span class="comments-pill">\${comments.length} comments</span>
              </div>
            </div>
            <div class="comments-list">\${commentsHtml}</div>
          </div>
        \`;
        postsContainer.appendChild(card);
      });
    }

    // Export JSON
    downloadJsonBtn.addEventListener('click', () => {
      if (!allScrapedItems.length) return alert('No data to export.');
      const blob = new Blob([JSON.stringify(allScrapedItems, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'instagram_comments_' + (currentTargetName || 'export') + '_' + Date.now() + '.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    // Export CSV with Comments
    downloadCsvBtn.addEventListener('click', () => {
      if (!allScrapedItems.length) return alert('No data to export.');
      const headers = ['post_shortcode', 'post_url', 'post_caption', 'comment_author', 'comment_time', 'comment_text', 'comment_url'];
      const rows = [];

      allScrapedItems.forEach(post => {
        const pCode = post.shortcode || '';
        const pUrl = post.url || '';
        const pDesc = '"' + (post.description || '').replace(/"/g, '""').replace(/\\n/g, ' ') + '"';
        if (post.comments && post.comments.length > 0) {
          post.comments.forEach(c => {
            rows.push([
              pCode,
              pUrl,
              pDesc,
              '"' + (c.author || '').replace(/"/g, '""') + '"',
              '"' + (c.time || '').replace(/"/g, '""') + '"',
              '"' + (c.text || '').replace(/"/g, '""').replace(/\\n/g, ' ') + '"',
              '"' + (c.comment_url || '').replace(/"/g, '""') + '"'
            ]);
          });
        } else {
          rows.push([pCode, pUrl, pDesc, '""', '""', '""', '""']);
        }
      });

      const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'instagram_comments_' + (currentTargetName || 'export') + '_' + Date.now() + '.csv';
      a.click();
      URL.revokeObjectURL(url);
    });

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, s => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[s]));
    }
  </script>
</body>
</html>`;

const parseJsonBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}); }
    catch (err) { reject(new Error('Invalid JSON')); }
  });
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_CONTENT);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/scrape') {
    try {
      const { type = 'user', input, count = 4, session = '' } = await parseJsonBody(req);

      if (!input) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Target input is required.' }));
      }

      console.log(`[API] Scraping request for: ${input} (type: ${type})`);
      const result = await scrapeInstagram({ type, input, count, session });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: result }));

    } catch (err) {
      console.error('[API] Scraping error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message || 'Scraping failed' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` Instagram OSINT Live Scraper running at: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
