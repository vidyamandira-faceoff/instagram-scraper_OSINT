/**
 * OASIS Intelligence & Reconnaissance Platform
 * Engine: OASIS Instagram Intelligence Engine (Headless Chromium Core)
 * Fully rebranded and expanded for multi-mode OSINT extraction
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

// Parse CLI flags and arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    target: '',
    count: 8,
    session: '',
    proxy: '',
    output: '',
    type: 'user',
    comments: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--target' || arg === '-t') {
      options.target = args[++i] || '';
    } else if (arg === '--count' || arg === '-c') {
      options.count = parseInt(args[++i], 10) || 8;
    } else if (arg === '--session' || arg === '-s') {
      options.session = args[++i] || '';
    } else if (arg === '--proxy' || arg === '-p') {
      options.proxy = args[++i] || '';
    } else if (arg === '--output' || arg === '-o') {
      options.output = args[++i] || '';
    } else if (arg === '--type') {
      options.type = args[++i] || 'user';
    } else if (arg === '--comments') {
      options.comments = true;
    }
  }
  return options;
}

// Locate Chrome or Chromium executable (Linux / Windows)
function getBrowserPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    path.join(homeDir, '.local/bin/google-chrome'),
    path.join(homeDir, '.local/bin/chromium'),
    path.join(homeDir, '.cache/puppeteer/chrome/linux-151.0.7922.47/chrome-linux64/chrome'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chrome',
    '/snap/bin/chromium',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Google Chrome or Chromium executable not found on this system.');
}

// Parse string counts like "104M", "5,008", "1.2K"
function parseCountString(str) {
  if (!str) return 0;
  const clean = str.replace(/,/g, '').trim().toUpperCase();
  if (clean.endsWith('M')) {
    return Math.round(parseFloat(clean) * 1000000);
  }
  if (clean.endsWith('K')) {
    return Math.round(parseFloat(clean) * 1000);
  }
  if (clean.endsWith('B')) {
    return Math.round(parseFloat(clean) * 1000000000);
  }
  return parseInt(clean, 10) || 0;
}

// Extract post comments from loaded post page
async function extractCommentsFromPage(page, postAuthor = '', maxComments = 20) {
  try {
    await page.waitForSelector('a[href*="/c/"], time, span[dir="auto"]', { timeout: 6000 });
  } catch (e) {}

  await new Promise(r => setTimeout(r, 1500));

  return await page.evaluate((authorToExclude, max) => {
    const list = [];
    const seen = new Set();
    const cleanAuthorToExclude = (authorToExclude || '').toLowerCase().trim();

    // Strategy 1: Find comment permalinks
    const commentAnchors = Array.from(document.querySelectorAll('a[href*="/c/"]'));
    for (const cl of commentAnchors) {
      let container = cl;
      let foundAuthor = null;
      let foundText = null;
      let foundAvatar = '';
      let timeText = cl.innerText.trim();

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

            if (textSpans.length > 0) foundText = textSpans[0];

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

    // Strategy 2: Fallback scan time elements
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

async function run() {
  const options = parseArgs();
  if (!options.target) {
    console.error('[OASIS:ERROR] Target parameter (--target) is required.');
    process.exit(1);
  }

  const rawTarget = options.target.trim();
  console.log(`[OASIS] Initializing OASIS Instagram Intelligence Engine for: ${rawTarget}`);
  console.log(`[OASIS] Target Type: ${options.type.toUpperCase()}, Max Items: ${options.count}, Extract Comments: ${options.comments}`);

  const browserPath = getBrowserPath();
  console.log(`[OASIS] Spawning headless Chromium instance: ${browserPath}`);

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1280,900'
  ];

  if (options.proxy) {
    launchArgs.push(`--proxy-server=${options.proxy.trim()}`);
    console.log(`[OASIS] Active proxy configured: ${options.proxy.trim()}`);
  }

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: 'new',
    args: launchArgs
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Apply session cookies if provided
    if (options.session && options.session.trim()) {
      const sessionVal = options.session.replace(/^sessionid=/, '').trim();
      const cookies = [
        { name: 'sessionid', value: sessionVal, domain: '.instagram.com', path: '/' }
      ];
      if (sessionVal.includes('%3A')) {
        const dsUserId = sessionVal.split('%3A')[0];
        cookies.push({ name: 'ds_user_id', value: dsUserId, domain: '.instagram.com', path: '/' });
      }
      await page.setCookie(...cookies);
      console.log(`[OASIS] Authenticated session cookies injected.`);
    }

    // Determine target URL and entity type
    let targetUrl = rawTarget;
    let targetUsername = '';
    let isDirectPost = rawTarget.includes('/p/') || rawTarget.includes('/reel/');
    let isHashtag = rawTarget.startsWith('#') || options.type === 'hashtag';
    let isLocation = rawTarget.startsWith('location:') || options.type === 'location';

    if (isDirectPost) {
      if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
    } else if (isHashtag) {
      const tag = rawTarget.replace(/^#/, '').replace(/^https?:\/\/(www\.)?instagram\.com\/explore\/tags\//, '').split('/')[0];
      targetUrl = `https://www.instagram.com/explore/tags/${tag}/`;
      targetUsername = `#${tag}`;
    } else if (isLocation) {
      const locId = rawTarget.replace(/^location:/i, '').replace(/^https?:\/\/(www\.)?instagram\.com\/explore\/locations\//, '').split('/')[0];
      targetUrl = `https://www.instagram.com/explore/locations/${locId}/`;
      targetUsername = `Location:${locId}`;
    } else {
      targetUsername = rawTarget.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').split('/')[0].split('?')[0];
      targetUrl = `https://www.instagram.com/${targetUsername}/`;
    }

    console.log(`[OASIS] Navigating to target endpoint: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise(r => setTimeout(r, 2500));

    // CASE 1: DIRECT SINGLE POST / REEL RECON
    if (isDirectPost) {
      console.log(`[OASIS] Extracting direct post and comment thread...`);
      const postDetails = await page.evaluate(() => {
        const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
        const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
        const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
        const img = document.querySelector('article img, div[role="dialog"] img, img[style*="object-fit"]');
        const descEl = document.querySelector('h1, span[dir="auto"]');

        return {
          thumbnail: ogImage || (img ? img.src : ''),
          caption: ogDesc || (descEl ? descEl.innerText.trim() : '') || ogTitle || '',
          title: ogTitle || document.title
        };
      });

      const match = targetUrl.match(/\/(p|reel)\/([^\/\?]+)/);
      const shortcode = match ? match[2] : 'post';
      const kind = match ? match[1] : 'post';

      const comments = await extractCommentsFromPage(page, '', 25);
      console.log(`[OASIS] Harvested ${comments.length} comments from post #${shortcode}`);

      const result = {
        engine: 'OASIS Instagram Intelligence Engine',
        version: '1.0.0',
        system: 'OASIS OSINT Suite',
        success: true,
        target: rawTarget,
        type: 'post',
        timestamp: new Date().toISOString(),
        profile: {
          username: targetUsername || shortcode,
          full_name: 'Single Post Inspection',
          biography: postDetails.caption,
          avatar: postDetails.thumbnail,
          followers_str: 'N/A',
          followers_count: 0,
          following_str: 'N/A',
          following_count: 0,
          posts_str: '1',
          posts_count: 1,
          is_verified: false,
          is_private: false,
          profile_url: targetUrl
        },
        posts: [
          {
            id: shortcode,
            shortcode: shortcode,
            type: kind,
            url: targetUrl,
            thumbnail: postDetails.thumbnail,
            caption: postDetails.caption,
            comments_count: comments.length,
            comments: comments
          }
        ],
        stats: {
          total_harvested: 1,
          total_comments: comments.length,
          followers_str: 'N/A',
          following_str: 'N/A',
          posts_str: '1',
          account_status: 'Single Post Active'
        }
      };

      if (options.output) {
        fs.writeFileSync(options.output, JSON.stringify(result, null, 2), 'utf-8');
        console.log(`[OASIS:SUCCESS] Output dossier saved to: ${options.output}`);
      }
      return;
    }

    // Dismiss any modal dialogs
    try {
      await page.evaluate(() => {
        const closeBtns = document.querySelectorAll('svg[aria-label="Close"], button[aria-label="Close"]');
        closeBtns.forEach(b => b.closest('button')?.click());
      });
    } catch (e) {}

    // Check account status
    const accountStatus = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      return {
        isPrivate: text.includes('This Account is Private') || text.includes('This account is private'),
        notFound: text.includes("Sorry, this page isn't available") || document.title.includes('Page Not Found'),
        noPosts: text.includes('No Posts Yet') || text.includes('No posts yet')
      };
    });

    if (accountStatus.notFound) {
      console.warn(`[OASIS:WARN] Target account @${targetUsername} does not exist or has been removed.`);
    }

    // Extract metadata from OpenGraph and DOM
    const metaData = await page.evaluate(() => {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
      const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
      const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute('content') || '';
      const pageTitle = document.title || '';

      const isVerified = Boolean(
        document.querySelector('svg[aria-label="Verified"]') ||
        document.querySelector('svg[aria-label*="verified"]') ||
        document.querySelector('[aria-label="Verified"]')
      );

      let bioText = '';
      const bioEl = document.querySelector('header section > div:last-child, header h1 ~ div, div._aa_c');
      if (bioEl) bioText = bioEl.innerText.trim();

      let externalUrl = '';
      const extEl = document.querySelector('header a[href*="l.instagram.com"], header a[target="_blank"]');
      if (extEl) externalUrl = extEl.innerText.trim() || extEl.getAttribute('href') || '';

      return {
        ogTitle,
        ogDesc,
        ogImage,
        ogUrl,
        pageTitle,
        isVerified,
        bioText,
        externalUrl
      };
    });

    console.log(`[OASIS] Profile Title: "${metaData.pageTitle}"`);
    console.log(`[OASIS] OpenGraph Summary: "${metaData.ogDesc}"`);

    let followersStr = '';
    let followingStr = '';
    let postsStr = '';
    let full_name = targetUsername;

    if (metaData.ogDesc) {
      const fMatch = metaData.ogDesc.match(/([0-9.,KkMmBb]+)\s*Followers/i);
      if (fMatch) followersStr = fMatch[1];

      const foMatch = metaData.ogDesc.match(/([0-9.,KkMmBb]+)\s*Following/i);
      if (foMatch) followingStr = foMatch[1];

      const pMatch = metaData.ogDesc.match(/([0-9.,KkMmBb]+)\s*Posts/i);
      if (pMatch) postsStr = pMatch[1];
    }

    if (metaData.ogTitle) {
      const nameMatch = metaData.ogTitle.match(/^([^(•]+)/);
      if (nameMatch) full_name = nameMatch[1].trim();
    }

    console.log(`[OASIS] Metrics: Followers: ${followersStr || '0'} | Following: ${followingStr || '0'} | Posts: ${postsStr || '0'}`);

    // Scroll to populate media grid
    await page.evaluate(() => window.scrollBy(0, 600));
    await new Promise(r => setTimeout(r, 1500));

    // Extract media items from profile grid
    console.log(`[OASIS] Harvesting media artifacts from target grid...`);
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
        const altText = img ? (img.getAttribute('alt') || '') : '';
        const thumb = img ? img.src : '';

        results.push({
          id: code,
          shortcode: code,
          type: kind === 'reel' ? 'reel' : 'post',
          url: `https://www.instagram.com/${kind}/${code}/`,
          thumbnail: thumb,
          caption: altText,
          is_video: kind === 'reel',
          comments_count: 0,
          comments: []
        });

        if (results.length >= maxCount) break;
      }
      return results;
    }, options.count);

    console.log(`[OASIS] Extracted ${posts.length} media items from profile grid.`);

    // If deep comments requested, visit each post to extract comments
    let totalCommentsCount = 0;
    if (options.comments && posts.length > 0) {
      console.log(`[OASIS] Extracting deep comments for ${posts.length} harvested posts...`);
      for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        try {
          console.log(`[OASIS] Fetching comments for #${p.shortcode} (${i + 1}/${posts.length})...`);
          await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          const postComments = await extractCommentsFromPage(page, targetUsername, 15);
          p.comments = postComments;
          p.comments_count = postComments.length;
          totalCommentsCount += postComments.length;
          console.log(`[OASIS] Extracted ${postComments.length} comments from #${p.shortcode}`);
        } catch (cErr) {
          console.log(`[OASIS:WARN] Could not harvest comments for #${p.shortcode}: ${cErr.message}`);
          p.comments = [];
          p.comments_count = 0;
        }
      }
    }

    const finalResult = {
      engine: 'OASIS Instagram Intelligence Engine',
      version: '1.0.0',
      system: 'OASIS OSINT Suite',
      success: true,
      target: targetUsername,
      type: options.type,
      timestamp: new Date().toISOString(),
      profile: {
        username: targetUsername,
        full_name: full_name || targetUsername,
        biography: metaData.bioText || '',
        avatar: metaData.ogImage || '',
        followers_str: followersStr || '0',
        followers_count: parseCountString(followersStr),
        following_str: followingStr || '0',
        following_count: parseCountString(followingStr),
        posts_str: postsStr || String(posts.length),
        posts_count: parseCountString(postsStr) || posts.length,
        is_verified: metaData.isVerified,
        is_private: accountStatus.isPrivate,
        external_url: metaData.externalUrl || '',
        profile_url: targetUrl
      },
      posts: posts,
      stats: {
        total_harvested: posts.length,
        total_comments: totalCommentsCount,
        followers_str: followersStr || 'N/A',
        following_str: followingStr || 'N/A',
        posts_str: postsStr || String(posts.length),
        account_status: accountStatus.isPrivate ? 'Private' : (accountStatus.notFound ? 'Not Found' : 'Public Active')
      }
    };

    if (options.output) {
      fs.writeFileSync(options.output, JSON.stringify(finalResult, null, 2), 'utf-8');
      console.log(`[OASIS:SUCCESS] Dossier compiled and saved to: ${options.output}`);
    } else {
      console.log('[OASIS_RESULT_START]');
      console.log(JSON.stringify(finalResult));
      console.log('[OASIS_RESULT_END]');
    }

  } catch (err) {
    console.error(`[OASIS:ERROR] Extraction failed: ${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
    console.log(`[OASIS] Headless Chromium browser closed.`);
  }
}

run().catch(err => {
  console.error(`[OASIS:FATAL] Execution halted: ${err.message}`);
  process.exit(1);
});
