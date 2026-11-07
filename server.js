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

    // Check if Instagram redirected to login wall or blocked unauthenticated access
    if (page.url() === 'https://www.instagram.com/' || page.url().includes('/accounts/login')) {
      throw new Error(`Instagram requires an active login session to view this target. Please paste a fresh sessionid cookie.`);
    }

    // Dismiss any modal overlay dialogs if present
    try {
      await page.evaluate(() => {
        const closeIcons = document.querySelectorAll('svg[aria-label="Close"], button[aria-label="Close"]');
        closeIcons.forEach(btn => btn.closest('button')?.click());
      });
    } catch (e) {}

    // Check target account status (private, not found, or 0 posts)
    const accountStatus = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const isPrivate = text.includes('This Account is Private') || text.includes('This account is private');
      const notFound = text.includes("Sorry, this page isn't available") || document.title.includes('Page Not Found');
      const noPosts = text.includes('No Posts Yet') || text.includes('No posts yet');
      return { isPrivate, notFound, noPosts };
    });

    if (accountStatus.notFound) {
      throw new Error(`The target account or URL does not exist or has been removed.`);
    }

    if (accountStatus.isPrivate) {
      throw new Error(`This account (@${targetUsername || 'target'}) is Private. An active session cookie with follower access is required.`);
    }

    if (accountStatus.noPosts) {
      throw new Error(`The account @${targetUsername || 'target'} was found, but it currently has 0 posts published.`);
    }

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

// High-Visibility Meaningful OSINT + Instagram Favicon SVG
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <radialGradient id="igGlow" cx="20%" cy="100%" r="120%">
      <stop offset="0%" stop-color="#ffdc80"/>
      <stop offset="25%" stop-color="#fcaf45"/>
      <stop offset="50%" stop-color="#f77737"/>
      <stop offset="75%" stop-color="#f56040"/>
      <stop offset="85%" stop-color="#e1306c"/>
      <stop offset="95%" stop-color="#c13584"/>
      <stop offset="100%" stop-color="#833ab4"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#igGlow)"/>
  <rect x="13" y="13" width="38" height="38" rx="10" fill="none" stroke="#ffffff" stroke-width="4.5" filter="url(#shadow)"/>
  <circle cx="32" cy="32" r="10.5" fill="none" stroke="#ffffff" stroke-width="4.5" filter="url(#shadow)"/>
  <line x1="32" y1="5" x2="32" y2="13" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/>
  <line x1="32" y1="51" x2="32" y2="59" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/>
  <line x1="5" y1="32" x2="13" y2="32" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/>
  <line x1="51" y1="32" x2="59" y2="32" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/>
  <circle cx="43.5" cy="20.5" r="3.2" fill="#ffffff" filter="url(#shadow)"/>
  <circle cx="32" cy="32" r="4.2" fill="#00f2fe"/>
  <circle cx="32" cy="32" r="2" fill="#ffffff"/>
</svg>`;

const FAVICON_DATA_URL = 'data:image/svg+xml;base64,' + Buffer.from(FAVICON_SVG).toString('base64');

// Embedded Single-Page Frontend
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Instagram OSINT Intelligence Dashboard</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URL}">
  <link rel="alternate icon" href="/favicon.ico">
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
      user-select: none;
    }
    .btn:hover:not(:disabled) {
      box-shadow: 0 6px 20px rgba(79, 70, 229, 0.5);
      transform: translateY(-1px);
    }
    .btn:active:not(:disabled) {
      transform: translateY(1px);
      box-shadow: 0 2px 10px rgba(79, 70, 229, 0.4);
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
      <div style="display: flex; align-items: center; justify-content: center; gap: 14px; margin: 4px 0 8px 0;">
        <img src="${FAVICON_DATA_URL}" alt="Logo" style="width: 44px; height: 44px; border-radius: 12px; box-shadow: 0 4px 18px rgba(225, 48, 108, 0.45); flex-shrink: 0;">
        <h1 style="margin: 0;">Instagram Intelligence Scraper</h1>
      </div>
      <p>Live post, media, and per-post comment extraction</p>
    </header>

    <div class="panel">
      <form id="scrapeForm" onsubmit="event.preventDefault(); startScraping(); return false;">
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

        <button type="button" id="submitBtn" class="btn" onclick="startScraping()">
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
          <button id="downloadPdfBtn" class="action-btn" style="background: linear-gradient(135deg, #6366f1, #a855f7); color: #ffffff; border-color: #6366f1; font-weight: 600; box-shadow: 0 2px 10px rgba(99, 102, 241, 0.35);">📑 Export PDF</button>
          <button id="downloadCsvBtn" class="action-btn">📊 Export CSV</button>
          <button id="downloadJsonBtn" class="action-btn">📥 Export JSON</button>
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
    const downloadPdfBtn = document.getElementById('downloadPdfBtn');
    const searchInput = document.getElementById('searchInput');
    const targetHeading = document.getElementById('targetHeading');
    const targetSubtext = document.getElementById('targetSubtext');
    const targetAvatar = document.getElementById('targetAvatar');

    let allScrapedItems = [];
    let currentTargetName = '';
    let showJson = false;

    // Auto-populate from URL query parameters if present (e.g. if reloaded or submitted)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('input')) document.getElementById('input').value = urlParams.get('input');
    if (urlParams.get('type')) document.getElementById('type').value = urlParams.get('type');
    if (urlParams.get('count')) document.getElementById('count').value = urlParams.get('count');
    if (urlParams.get('session')) document.getElementById('session').value = urlParams.get('session');

    toggleJsonBtn.addEventListener('click', () => {
      showJson = !showJson;
      rawJson.style.display = showJson ? 'block' : 'none';
      toggleJsonBtn.textContent = showJson ? 'Hide Code' : 'Code View';
    });

    function handleMediaError(img) {
      img.onerror = null;
      img.src = 'https://placehold.co/400x300/1e293b/white?text=Media+Preview';
    }

    function copyToClipboard(text, msg) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      }
      if (msg) alert(msg);
    }

    let isScraping = false;

    async function startScraping() {
      if (isScraping) return;

      const targetInput = document.getElementById('input');
      const target = (targetInput.value || '').trim();
      const type = document.getElementById('type').value;
      const count = parseInt(document.getElementById('count').value, 10) || 4;
      const session = (document.getElementById('session').value || '').trim();

      if (!target) {
        statusBox.style.display = 'flex';
        statusBox.className = 'status-box error';
        statusBox.innerHTML = '⚠️ <strong>Missing Target:</strong> Please enter an Instagram username or direct post URL.';
        targetInput.focus();
        targetInput.style.borderColor = '#ef4444';
        targetInput.addEventListener('input', () => { targetInput.style.borderColor = ''; }, { once: true });
        return;
      }

      currentTargetName = target;
      isScraping = true;

      statusBox.style.display = 'flex';
      statusBox.className = 'status-box info';
      statusBox.innerHTML = '<span class="spinner"></span> <span>Scraping live posts and structured comments... (~15-25s)</span>';
      submitBtn.disabled = true;
      submitBtn.style.cursor = 'wait';
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

        let data;
        try {
          data = await res.json();
        } catch (jsonErr) {
          throw new Error('Server returned unexpected response (HTTP ' + res.status + '). Is the server running?');
        }

        if (!data.success) {
          throw new Error(data.error || 'Failed to extract data.');
        }

        allScrapedItems = data.data.collector || [];

        statusBox.className = 'status-box info';
        statusBox.innerHTML = '✅ Successfully extracted ' + allScrapedItems.length + ' posts with structured comments.';

        targetHeading.textContent = target.startsWith('http') ? target : '@' + target.replace(/^@/, '');
        targetSubtext.textContent = allScrapedItems.length + ' posts analyzed • ' + new Date().toLocaleTimeString();
        targetAvatar.textContent = target.replace(/^[@https://www\.]*/, '').charAt(0).toUpperCase() || 'IG';

        renderPostsWithComments(allScrapedItems);

        rawJson.textContent = JSON.stringify(data.data, null, 2);
        resultsSection.style.display = 'block';

      } catch (err) {
        statusBox.style.display = 'flex';
        statusBox.className = 'status-box error';
        const msg = (err.message && err.message.includes('Failed to fetch'))
          ? 'Failed to connect to backend server. Please verify that "node server.js" is actively running in your terminal.'
          : err.message;
        statusBox.innerHTML = '⚠️ <strong>Extraction Error:</strong> ' + escapeHtml(msg);
      } finally {
        isScraping = false;
        submitBtn.disabled = false;
        submitBtn.style.cursor = 'pointer';
        btnText.textContent = 'Launch Scraper';
      }
    }

    window.startScraping = startScraping;

    submitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      startScraping();
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      startScraping();
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
          commentsHtml = comments.map(function(c) {
            const initial = (c.author || 'U').charAt(0).toUpperCase();
            const aUrl = c.author_url || ('https://www.instagram.com/' + (c.author || '') + '/');
            const author = escapeHtml(c.author || 'anonymous');
            const time = escapeHtml(c.time || '');
            const text = escapeHtml(c.text || '');
            const permalink = c.comment_url ? ('<div style="margin-top: 4px;"><a href="' + c.comment_url + '" target="_blank" rel="noopener" style="font-size: 11px; color: #818cf8; text-decoration: none;">View on Instagram ↗</a></div>') : '';

            return '<div class="comment-bubble">' +
              '<div class="comment-avatar">' + initial + '</div>' +
              '<div class="comment-body">' +
                '<div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px;">' +
                  '<a href="' + aUrl + '" target="_blank" rel="noopener" class="comment-author">@' + author + '</a>' +
                  '<span style="font-size: 11px; color: #94a3b8; margin-left: 8px;">' + time + '</span>' +
                '</div>' +
                '<div class="comment-text">' + text + '</div>' +
                permalink +
              '</div>' +
            '</div>';
          }).join('');
        } else {
          commentsHtml = '<p class="no-comments-msg">No visible comments found on this post (comments may be disabled or limited).</p>';
        }

        const mediaPreview = imgSrc 
          ? ('<img src="' + imgSrc + '" loading="lazy" onerror="handleMediaError(this)">')
          : '<div style="padding:40px;color:#64748b;text-align:center;">No Image Preview</div>';
        const badgeText = isReel ? '🎬 Reel' : '📸 Post';

        card.innerHTML = 
          '<div class="post-main-row">' +
            '<div class="post-media-col">' +
              mediaPreview +
              '<span class="post-badge">' + badgeText + '</span>' +
            '</div>' +
            '<div class="post-content-col">' +
              '<div class="post-meta-top">' +
                '<span class="post-code" title="Click to copy" data-code="' + shortcode + '" onclick="copyToClipboard(this.dataset.code)">#' + shortcode + ' 📋</span>' +
                '<span style="color:#94a3b8;font-size:12px;">Post #' + (idx + 1) + '</span>' +
              '</div>' +
              '<div class="post-caption">' + (caption || '<span style="color:#64748b;font-style:italic;">No caption provided</span>') + '</div>' +
              '<div class="post-links">' +
                '<a href="' + postUrl + '" target="_blank" rel="noopener" class="post-link-btn">View Post on Instagram ↗</a>' +
                '<button class="action-btn" style="padding:4px 8px;font-size:11px;" data-url="' + postUrl + '" onclick="copyToClipboard(this.dataset.url, &quot;Post URL copied!&quot;)">Share Link</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="comments-section">' +
            '<div class="comments-header">' +
              '<div class="comments-title">' +
                '<span>💬 Comments on this Post</span>' +
                '<span class="comments-pill">' + comments.length + ' comments</span>' +
              '</div>' +
            '</div>' +
            '<div class="comments-list">' + commentsHtml + '</div>' +
          '</div>';
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

    // Export Comprehensive OSINT PDF Report
    downloadPdfBtn.addEventListener('click', () => {
      if (!allScrapedItems.length) return alert('No data to generate PDF report.');
      generatePdfReport(currentTargetName, allScrapedItems);
    });

    function generatePdfReport(targetName, posts) {
      if (!posts || posts.length === 0) return alert('No scraped data available to generate PDF.');

      const dateStr = new Date().toLocaleString();
      let totalComments = 0;
      posts.forEach(p => { totalComments += (p.comments ? p.comments.length : 0); });

      let postsHtml = '';
      posts.forEach((p, idx) => {
        const shortcode = p.shortcode || p.id || 'N/A';
        const postUrl = p.url || ('https://www.instagram.com/p/' + shortcode + '/');
        const isReel = p.is_video || p.type === 'reel';
        const img = p.thumbnail_src || p.display_url || '';
        const caption = escapeHtml(p.description || '').replace(/\\n/g, '<br>');
        const comments = p.comments || [];

        let commentsRows = '';
        if (comments.length > 0) {
          comments.forEach((c, cIdx) => {
            commentsRows += '<tr>' +
              '<td style="width: 32px; text-align: center; color: #64748b; font-weight: 600;">' + (cIdx + 1) + '</td>' +
              '<td style="width: 140px; font-weight: 600; color: #4338ca;">@' + escapeHtml(c.author || 'anonymous') + '</td>' +
              '<td style="width: 65px; color: #64748b; font-size: 11px;">' + escapeHtml(c.time || '') + '</td>' +
              '<td style="color: #1e293b; line-height: 1.4;">' + escapeHtml(c.text || '') + '</td>' +
            '</tr>';
          });
        } else {
          commentsRows = '<tr><td colspan="4" style="text-align: center; color: #94a3b8; font-style: italic; padding: 12px;">No visible comments found on this post.</td></tr>';
        }

        postsHtml += '<div class="post-card">' +
          '<div class="post-header">' +
            '<div>' +
              '<span class="post-title">Post #' + (idx + 1) + '</span>' +
              '<span class="post-code">#' + shortcode + '</span>' +
              '<span class="post-badge">' + (isReel ? '🎬 Reel' : '📸 Post') + '</span>' +
            '</div>' +
            '<a href="' + postUrl + '" target="_blank" class="post-link">' + postUrl + ' ↗</a>' +
          '</div>' +
          '<div class="post-body">' +
            (img ? '<img src="' + img + '" class="post-img" alt="Thumbnail" onerror="this.remove()">' : '') +
            '<div class="post-caption-box">' +
              '<div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; margin-bottom: 4px;">Post Caption</div>' +
              '<div class="post-caption">' + (caption || '<span style="color:#94a3b8; font-style:italic;">No caption provided</span>') + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="margin-top: 14px;">' +
            '<div style="font-size: 12px; font-weight: 700; color: #1e1b4b; margin-bottom: 6px; display: flex; justify-content: space-between;">' +
              '<span>💬 Comments on this Post (' + comments.length + ')</span>' +
              '<span style="font-size: 11px; font-weight: normal; color: #64748b;">Structured Per-Post Intelligence</span>' +
            '</div>' +
            '<table class="report-table">' +
              '<thead><tr><th>#</th><th>Author</th><th>Time</th><th>Comment Text</th></tr></thead>' +
              '<tbody>' + commentsRows + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>';
      });

      const fullHtml = '<!DOCTYPE html>' +
        '<html>' +
        '<head>' +
          '<meta charset="utf-8">' +
          '<title>OSINT Intelligence Report - ' + escapeHtml(targetName || 'Export') + '</title>' +
          '<style>' +
            '@page { size: A4; margin: 12mm 10mm; }' +
            '* { box-sizing: border-box; }' +
            'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; color: #0f172a; background: #f8fafc; font-size: 13px; }' +
            '.no-print-bar { position: sticky; top: 0; background: #0f172a; color: #fff; padding: 12px 20px; margin: -24px -24px 24px -24px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 1000; }' +
            '.btn-print { background: #6366f1; color: white; border: none; padding: 8px 18px; font-size: 13px; font-weight: 700; border-radius: 6px; cursor: pointer; }' +
            '.btn-print:hover { background: #4f46e5; }' +
            '.btn-close { background: transparent; color: #94a3b8; border: 1px solid #334155; padding: 6px 14px; font-size: 12px; border-radius: 6px; cursor: pointer; }' +
            '.report-container { max-width: 900px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; box-shadow: 0 2px 10px rgba(0,0,0,0.03); }' +
            '.header-box { border-bottom: 2px solid #6366f1; padding-bottom: 20px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: flex-start; }' +
            '.header-left h1 { margin: 0 0 6px 0; font-size: 24px; font-weight: 800; color: #1e1b4b; letter-spacing: -0.5px; }' +
            '.header-left p { margin: 0; color: #64748b; font-size: 13px; }' +
            '.classification-tag { background: #eef2ff; color: #4338ca; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 20px; border: 1px solid #c7d2fe; text-transform: uppercase; }' +
            '.kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 28px; }' +
            '.kpi-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; }' +
            '.kpi-label { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; margin-bottom: 4px; }' +
            '.kpi-val { font-size: 16px; font-weight: 800; color: #0f172a; word-break: break-all; }' +
            '.post-card { border: 1px solid #cbd5e1; border-radius: 10px; padding: 18px; margin-bottom: 24px; background: #ffffff; page-break-inside: avoid; break-inside: avoid; }' +
            '.post-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f1f5f9; padding-bottom: 10px; margin-bottom: 12px; }' +
            '.post-title { font-weight: 700; font-size: 14px; color: #0f172a; margin-right: 8px; }' +
            '.post-code { font-family: monospace; font-size: 13px; font-weight: 700; color: #6366f1; background: #eef2ff; padding: 2px 8px; border-radius: 4px; margin-right: 8px; }' +
            '.post-badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #f1f5f9; color: #475569; font-weight: 600; }' +
            '.post-link { font-size: 11px; color: #6366f1; text-decoration: none; word-break: break-all; }' +
            '.post-body { display: flex; gap: 16px; margin-bottom: 12px; }' +
            '.post-img { width: 130px; height: 130px; object-fit: cover; border-radius: 8px; border: 1px solid #e2e8f0; flex-shrink: 0; }' +
            '.post-caption-box { flex: 1; }' +
            '.post-caption { font-size: 12.5px; color: #334155; line-height: 1.5; word-break: break-word; }' +
            '.report-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }' +
            '.report-table th { background: #f8fafc; color: #475569; font-weight: 700; text-align: left; padding: 8px 10px; border: 1px solid #e2e8f0; font-size: 11px; text-transform: uppercase; }' +
            '.report-table td { padding: 8px 10px; border: 1px solid #e2e8f0; vertical-align: top; }' +
            '.report-table tr:nth-child(even) { background: #fcfcfd; }' +
            '.report-footer { border-top: 1px solid #e2e8f0; margin-top: 32px; padding-top: 14px; text-align: center; font-size: 11px; color: #94a3b8; }' +
            '@media print {' +
              'body { background: #ffffff; padding: 0; font-size: 12px; }' +
              '.no-print-bar { display: none !important; }' +
              '.report-container { max-width: 100%; border: none; box-shadow: none; padding: 0; }' +
              '.post-card { border: 1px solid #e2e8f0; break-inside: avoid; page-break-inside: avoid; margin-bottom: 20px; }' +
              'a { text-decoration: none; color: inherit; }' +
            '}' +
          '</style>' +
        '</head>' +
        '<body>' +
          '<div class="no-print-bar">' +
            '<div style="display:flex; align-items:center; gap:8px;">' +
              '<strong>🛡️ Instagram OSINT Forensic Report</strong>' +
              '<span style="color:#94a3b8; font-size:12px;">(Select "Save as PDF" to download)</span>' +
            '</div>' +
            '<div style="display:flex; gap:10px;">' +
              '<button class="btn-print" onclick="window.print()">🖨️ Download / Save as PDF</button>' +
              '<button class="btn-close" onclick="window.close()">Close</button>' +
            '</div>' +
          '</div>' +
          '<div class="report-container">' +
            '<div class="header-box">' +
              '<div class="header-left">' +
                '<h1>Instagram Intelligence Forensic Dossier</h1>' +
                '<p>Structured Media & Per-Post Comment OSINT Analysis</p>' +
              '</div>' +
              '<div><span class="classification-tag">OSINT EXPORT</span></div>' +
            '</div>' +
            '<div class="kpi-grid">' +
              '<div class="kpi-card"><div class="kpi-label">Target Subject</div><div class="kpi-val">' + escapeHtml(targetName || 'N/A') + '</div></div>' +
              '<div class="kpi-card"><div class="kpi-label">Posts Analyzed</div><div class="kpi-val">' + posts.length + '</div></div>' +
              '<div class="kpi-card"><div class="kpi-label">Total Comments</div><div class="kpi-val">' + totalComments + '</div></div>' +
              '<div class="kpi-card"><div class="kpi-label">Generated At</div><div class="kpi-val" style="font-size:12px;">' + dateStr + '</div></div>' +
            '</div>' +
            '<div>' + postsHtml + '</div>' +
            '<div class="report-footer">Generated by Instagram OSINT Intelligence Scraper • ' + dateStr + '</div>' +
          '</div>' +
        '</body>' +
        '</html>';

      const printWin = window.open('', '_blank');
      if (!printWin) {
        alert('Please allow pop-ups in your browser to view and download the PDF report.');
        return;
      }
      printWin.document.open();
      printWin.document.write(fullHtml);
      printWin.document.close();
      setTimeout(function() {
        try {
          printWin.focus();
          printWin.print();
        } catch (e) {}
      }, 700);
    }

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
  const pathname = req.url.split('?')[0];

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_CONTENT);
    return;
  }

  if (req.method === 'GET' && (pathname === '/favicon.ico' || pathname === '/favicon.svg')) {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400'
    });
    res.end(FAVICON_SVG);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/scrape') {
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
