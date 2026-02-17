/**
 * Perplexity AI - Browser-based Client (No Login Required)
 *
 * How it works:
 *   1. Runs a headless Chrome browser via Puppeteer (no window)
 *   2. Navigates to perplexity.ai
 *   3. Types your question and submits it
 *   4. Watches the page for the answer to appear
 *   5. Prints the final answer in the console and exits
 *
 * Usage:
 *   1. Edit the QUERY constant below to set your question
 *   2. Run: node perplexity.js
 *   
 *   OR pass question as argument:
 *   node perplexity.js "Your question here"
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// ✏️  EDIT YOUR QUESTION HERE:
// ═══════════════════════════════════════════════════════════════════════════

const QUERY = `
Time limit: 1.00 s Memory limit: 512 MB
Given an array of n integers, your task is to count the number of subarrays having sum x.

Input
The first input line has two integers n and x: the size of the array and the target sum x.

The next line has n integers a_1,a_2,\dots,a_n: the contents of the array.

Output
Print one integer: the required number of subarrays.

Constraints
1 \le n \le 2 \cdot 10^5
-10^9 \le x,a_i \le 10^9
Example
Input:

5 7
2 -1 3 5 -2
Output:

2
give most optimal solution with code in c++
`;

// ═══════════════════════════════════════════════════════════════════════════

const COOKIE_FILE = path.join(__dirname, '.perplexity-cookies.json');

// ─── Main Function ──────────────────────────────────────────────────────────

async function askPerplexity(query) {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║          PERPLEXITY AI - Browser Client                   ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`\n📝 Query: "${query}"\n`);

    const browser = await puppeteer.launch({
        headless: 'new',
        defaultViewport: { width: 1920, height: 1080 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu'
        ]
    });

    const page = await browser.newPage();

    // Hide automation signals
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        delete navigator.__proto__.webdriver;
    });

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    );

    // ── Restore saved cookies if available ──
    if (fs.existsSync(COOKIE_FILE)) {
        try {
            const savedCookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
            await page.setCookie(...savedCookies);
            console.log('🍪 Restored saved cookies from previous session');
        } catch {
            console.log('⚠️  Could not restore cookies, starting fresh');
        }
    }

    // ── Navigate ──
    console.log('🌐 Opening perplexity.ai...');
    await page.goto('https://www.perplexity.ai', {
        waitUntil: 'networkidle2',
        timeout: 60000
    });
    console.log('✅ Page loaded!\n');

    // ── Save cookies for next time ──
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    console.log('🍪 Cookies saved for future sessions');

    // ── Wait for page to be fully ready ──
    await new Promise(r => setTimeout(r, 2000));

    // ── Type and submit the query ──
    console.log('─'.repeat(60));
    console.log('🔄 Submitting query...\n');

    const submitted = await submitQuery(page, query);
    if (!submitted) {
        console.log('❌ Could not submit query.');
        await browser.close();
        return null;
    }

    // ── Wait for the answer by watching the DOM ──
    console.log('⏳ Waiting for answer...\n');
    const result = await waitForAnswer(page, 120000);

    // ── Debug: save page HTML for analysis ──
    if (process.env.DEBUG_HTML) {
        const html = await page.content();
        fs.writeFileSync(path.join(__dirname, 'debug-page.html'), html);
        console.log('🐛 Debug HTML saved to debug-page.html');
    }

    // ── Print final result ──
    printResult(query, result);

    // ── Save updated cookies ──
    const updatedCookies = await page.cookies();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(updatedCookies, null, 2));

    // ── Close browser and exit ──
    await browser.close();
    return result;
}

// ─── Submit a query via the browser UI ──────────────────────────────────────

async function submitQuery(page, query) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const selectors = [
        'textarea',
        '[contenteditable="true"]',
        'input[type="text"]',
        '[placeholder*="Ask"]',
        '[placeholder*="Search"]',
        '[role="textbox"]'
    ];

    for (const selector of selectors) {
        try {
            const elements = await page.$$(selector);
            for (const element of elements) {
                const isVisible = await element.evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && rect.height > 0
                        && rect.width > 0;
                });

                if (!isVisible) continue;

                await element.click();
                await new Promise(r => setTimeout(r, 300));

                // Clear existing text
                await page.keyboard.down('Control');
                await page.keyboard.press('a');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 200));

                // Insert text instantly via CDP (much faster than typing char by char)
                const client = await page.createCDPSession();
                await client.send('Input.insertText', { text: query });
                await client.detach();
                await new Promise(r => setTimeout(r, 500));
                await page.keyboard.press('Enter');

                console.log('✅ Query submitted!\n');
                return true;
            }
        } catch {
            continue;
        }
    }

    console.log('⚠️  Could not find input field on the page.');
    return false;
}

// ─── Wait for the answer by polling the DOM ─────────────────────────────────

async function waitForAnswer(page, timeout) {
    const start = Date.now();
    let lastText = '';
    let stableCount = 0;

    // Wait for the page to start generating the answer
    await new Promise(r => setTimeout(r, 5000));

    // Save debug HTML once after initial wait
    let debugSaved = false;

    while (Date.now() - start < timeout) {
        const extraction = await page.evaluate(() => {
            // ── 1. Find the answer text ──
            // Perplexity renders each answer section in a ".prose" container.
            // Multiple .prose blocks = multiple paragraphs of the answer.
            // Citation badges (<span class="citation">) are inline junk — remove them.

            const proseEls = document.querySelectorAll(
                '.prose.dark\\:prose-invert'
            );

            let paragraphs = [];
            for (const el of proseEls) {
                // Clone the element so we can strip citation badges without
                // mutating the live DOM
                const clone = el.cloneNode(true);

                // Remove citation badges (the inline [1], "mckinsey +2" etc.)
                clone.querySelectorAll('.citation, .citation-nbsp, [class*="SeeMore"]')
                    .forEach(c => c.remove());

                const text = (clone.innerText || clone.textContent || '').trim();
                if (text.length > 5) {
                    paragraphs.push(text);
                }
            }

            let answerText = paragraphs.join('\n\n');

            // Fallback: if .prose didn't match, try broader selectors
            if (answerText.length < 30) {
                const fallbackSels = [
                    '[class*="MarkdownBlock"]', '[class*="answer"]',
                    '[class*="response"]', '[data-testid*="answer"]',
                    'article', 'main'
                ];
                for (const sel of fallbackSels) {
                    const els = document.querySelectorAll(sel);
                    for (const el of els) {
                        const clone = el.cloneNode(true);
                        clone.querySelectorAll('.citation, .citation-nbsp, [class*="SeeMore"]')
                            .forEach(c => c.remove());
                        const t = (clone.innerText || '').trim();
                        if (t.length > answerText.length) answerText = t;
                    }
                }
            }

            // ── 2. Extract sources from citation data attributes ──
            const citationEls = document.querySelectorAll('[data-pplx-citation-url]');
            const sources = [];
            const seen = new Set();
            for (const el of citationEls) {
                const url = el.getAttribute('data-pplx-citation-url');
                // Get the visible label next to it or its aria-label
                const label = el.closest('[aria-label]')?.getAttribute('aria-label')
                    || el.textContent?.trim() || '';
                if (url && !seen.has(url)) {
                    seen.add(url);
                    sources.push({ title: label || url, url });
                }
            }

            // Also grab any other external links not yet captured
            if (sources.length === 0) {
                const links = document.querySelectorAll(
                    'a[href^="http"]:not([href*="perplexity.ai"]):not([href*="google.com"])'
                );
                for (const a of links) {
                    const url = a.href;
                    const title = a.textContent?.trim() || '';
                    if (url && !seen.has(url) && title.length > 2 && title.length < 200) {
                        seen.add(url);
                        sources.push({ title, url });
                    }
                }
            }

            // ── 3. Detect if still loading ──
            const isLoading = !!(
                document.querySelector('[class*="animate-spin"]') ||
                document.querySelector('[class*="animate-pulse"]') ||
                document.querySelector('[class*="Spinner"]') ||
                document.querySelector('.loading-spinner')
            );

            const prevLen = parseInt(document.body.getAttribute('data-prev-len') || '0');
            document.body.setAttribute('data-prev-len', String(answerText.length));
            const isGrowing = answerText.length > prevLen && prevLen > 0;

            return { answerText, sources, isLoading: isLoading || isGrowing };
        });

        if (extraction.answerText) {
            // Save debug HTML once (after 10s) if DEBUG_HTML is set
            if (!debugSaved && Date.now() - start > 10000 && process.env.DEBUG_HTML) {
                const html = await page.content();
                const fs2 = require('fs');
                fs2.writeFileSync(require('path').join(__dirname, 'debug-page.html'), html);
                console.log('\n🐛 Debug HTML saved');
                debugSaved = true;
            }

            // Show progress while loading
            if (extraction.isLoading) {
                process.stdout.write('.');
            }

            // Check if answer has stabilized (unchanged for several checks AND not loading)
            if (extraction.answerText === lastText) {
                stableCount++;
                // If text is stable for 3s and not loading, or 8s regardless
                if ((!extraction.isLoading && stableCount >= 3) || stableCount >= 8) {
                    console.log('\n\n✅ Answer complete!');
                    return { answer: extraction.answerText, sources: extraction.sources };
                }
            } else {
                stableCount = 0;
            }
            lastText = extraction.answerText;
        }

        await new Promise(r => setTimeout(r, 1000));
    }

    if (lastText) {
        console.log('\n\n⏰ Timeout, but captured partial answer.');
        return { answer: lastText, sources: [] };
    }

    console.log('\n\n⏰ Timeout — no answer captured.');
    return { answer: '', sources: [] };
}

// ─── Pretty print the result ────────────────────────────────────────────────

function printResult(query, result) {
    console.log('\n' + '═'.repeat(60));
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║               FINAL ANSWER                               ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log();

    if (result.answer) {
        console.log(result.answer);
    } else {
        console.log('(No answer captured — check the browser window)');
    }

    if (result.sources && result.sources.length > 0) {
        console.log('\n' + '─'.repeat(60));
        console.log('🔗 Sources:\n');
        result.sources.forEach((src, i) => {
            console.log(`  ${i + 1}. ${src.title}`);
            if (src.url) console.log(`     ${src.url}`);
        });
    }

    console.log('\n' + '═'.repeat(60));
}

// ─── Entry Point ────────────────────────────────────────────────────────────

async function main() {
    // Use the QUERY constant defined at the top of the file
    // You can also override it with command-line arguments if needed:
    // node perplexity.js "Some other question"
    const query = process.argv.slice(2).join(' ') || QUERY;

    console.log('💡 Tip: Edit the QUERY constant at the top of this file to change the question\n');

    await askPerplexity(query);
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});
