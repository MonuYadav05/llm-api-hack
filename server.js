/**
 * Perplexity AI - OpenAI-Compatible API Server
 *
 * Exposes Perplexity AI as a standard OpenAI-compatible REST API.
 * Uses a persistent headless browser to query perplexity.ai.
 *
 * Endpoints:
 *   POST /v1/chat/completions   — OpenAI-compatible chat completions
 *   GET  /v1/models             — List available models
 *   GET  /health                — Health check
 *
 * Usage:
 *   node server.js
 *   # Server starts on port 3000 (or PORT env var)
 *
 * Example request (curl):
 *   curl http://localhost:3000/v1/chat/completions \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"perplexity","messages":[{"role":"user","content":"What is Node.js?"}]}'
 *
 * Streaming:
 *   curl http://localhost:3000/v1/chat/completions \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"perplexity","messages":[{"role":"user","content":"What is Node.js?"}],"stream":true}'
 */

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const COOKIE_FILE = path.join(__dirname, '.perplexity-cookies.json');
const MODEL_NAME = 'perplexity';
const MAX_TIMEOUT = 120000; // 2 minutes max per query

// ─── Global State ───────────────────────────────────────────────────────────

let browser = null;
let browserReady = false;
const requestQueue = [];
let processing = false;

// ─── Browser Management ────────────────────────────────────────────────────

async function initBrowser() {
    console.log('🚀 Launching headless browser...');
    browser = await puppeteer.launch({
        headless: 'new',
        defaultViewport: { width: 1920, height: 1080 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu'
        ]
    });

    // Handle unexpected browser close
    browser.on('disconnected', () => {
        console.log('⚠️  Browser disconnected, will restart on next request');
        browserReady = false;
        browser = null;
    });

    browserReady = true;
    console.log('✅ Browser ready');
}

async function ensureBrowser() {
    if (!browser || !browserReady) {
        await initBrowser();
    }
    return browser;
}

async function createPage() {
    const b = await ensureBrowser();

    // Use an incognito browser context for each request.
    // This gives a completely fresh cookie jar every time,
    // so we never accidentally land on a previous conversation.
    const context = await b.createBrowserContext();
    const page = await context.newPage();

    // Hide automation signals
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        delete navigator.__proto__.webdriver;
    });

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    );

    return { page, context };
}

// ─── Core Query Logic ──────────────────────────────────────────────────────

async function submitQuery(page, query) {
    await new Promise(r => setTimeout(r, 2000));

    // Scroll to bottom first — input might be at the bottom of the page
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 500));

    const selectors = [
        'textarea',
        '[contenteditable="true"]',
        'input[type="text"]',
        '[placeholder*="Ask"]',
        '[placeholder*="Search"]',
        '[placeholder*="follow"]',
        '[role="textbox"]'
    ];

    for (const selector of selectors) {
        try {
            const elements = await page.$$(selector);
            for (const element of elements) {
                const isVisible = await element.evaluate(el => {
                    el.scrollIntoView({ behavior: 'instant', block: 'center' });
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

                // Insert text instantly via CDP
                const client = await page.createCDPSession();
                await client.send('Input.insertText', { text: query });
                await client.detach();
                await new Promise(r => setTimeout(r, 500));
                await page.keyboard.press('Enter');

                return true;
            }
        } catch {
            continue;
        }
    }

    return false;
}

async function extractAnswer(page) {
    return page.evaluate(() => {
        const proseEls = document.querySelectorAll('.prose.dark\\:prose-invert');

        let paragraphs = [];
        for (const el of proseEls) {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('.citation, .citation-nbsp, [class*="SeeMore"]')
                .forEach(c => c.remove());
            const text = (clone.innerText || clone.textContent || '').trim();
            if (text.length > 5) {
                paragraphs.push(text);
            }
        }

        let answerText = paragraphs.join('\n\n');

        // Fallback
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

        // Sources
        const citationEls = document.querySelectorAll('[data-pplx-citation-url]');
        const sources = [];
        const seen = new Set();
        for (const el of citationEls) {
            const url = el.getAttribute('data-pplx-citation-url');
            const label = el.closest('[aria-label]')?.getAttribute('aria-label')
                || el.textContent?.trim() || '';
            if (url && !seen.has(url)) {
                seen.add(url);
                sources.push({ title: label || url, url });
            }
        }

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

        // Loading state
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
}

/**
 * Run a query against Perplexity and return the full answer.
 * If onChunk callback is provided, it will be called with incremental text.
 */
async function queryPerplexity(query, onChunk = null) {
    const { page, context } = await createPage();
    const requestId = crypto.randomUUID();

    try {
        console.log(`[${requestId}] 🌐 Navigating to perplexity.ai...`);
        await page.goto('https://www.perplexity.ai/', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        await new Promise(r => setTimeout(r, 2000));

        console.log(`[${requestId}] 🔄 Submitting query...`);
        const submitted = await submitQuery(page, query);
        if (!submitted) {
            throw new Error('Could not find input field on Perplexity page');
        }

        console.log(`[${requestId}] ⏳ Waiting for answer...`);

        // Poll for the answer
        const start = Date.now();
        let lastText = '';
        let stableCount = 0;
        let lastChunkedLength = 0;

        await new Promise(r => setTimeout(r, 5000));

        while (Date.now() - start < MAX_TIMEOUT) {
            const extraction = await extractAnswer(page);

            if (extraction.answerText) {
                // Send incremental chunks for streaming
                if (onChunk && extraction.answerText.length > lastChunkedLength) {
                    const newContent = extraction.answerText.slice(lastChunkedLength);
                    onChunk(newContent);
                    lastChunkedLength = extraction.answerText.length;
                }

                if (extraction.answerText === lastText) {
                    stableCount++;
                    if ((!extraction.isLoading && stableCount >= 3) || stableCount >= 8) {
                        console.log(`[${requestId}] ✅ Answer complete (${extraction.answerText.length} chars)`);

                        return {
                            answer: extraction.answerText,
                            sources: extraction.sources
                        };
                    }
                } else {
                    stableCount = 0;
                }
                lastText = extraction.answerText;
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        // Timeout — return whatever we have
        if (lastText) {
            console.log(`[${requestId}] ⏰ Timeout, returning partial answer`);
            return { answer: lastText, sources: [] };
        }

        throw new Error('Timeout: no answer received from Perplexity');

    } finally {
        await page.close().catch(() => { }); await context.close().catch(() => { });
    }
}

// ─── Request Queue (one query at a time) ────────────────────────────────────

function enqueue(task) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ task, resolve, reject });
        processQueue();
    });
}

async function processQueue() {
    if (processing || requestQueue.length === 0) return;
    processing = true;

    const { task, resolve, reject } = requestQueue.shift();
    try {
        const result = await task();
        resolve(result);
    } catch (err) {
        reject(err);
    } finally {
        processing = false;
        if (requestQueue.length > 0) {
            processQueue();
        }
    }
}

// ─── OpenAI Format Helpers ──────────────────────────────────────────────────

function buildCompletionResponse(content, model, sources = []) {
    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 29);

    // Append sources as footnotes if available
    let fullContent = content;
    if (sources.length > 0) {
        fullContent += '\n\n---\n**Sources:**\n';
        sources.forEach((src, i) => {
            fullContent += `${i + 1}. [${src.title}](${src.url})\n`;
        });
    }

    return {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || MODEL_NAME,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: fullContent
            },
            finish_reason: 'stop'
        }],
        usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
    };
}

function buildStreamChunk(content, model, finishReason = null) {
    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 29);
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || MODEL_NAME,
        choices: [{
            index: 0,
            delta: finishReason ? {} : { content },
            finish_reason: finishReason
        }]
    };
}

// ─── Express Server ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ── Health Check ──
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        browser: browserReady ? 'running' : 'stopped',
        queueLength: requestQueue.length,
        processing
    });
});

// ── List Models ──
app.get('/v1/models', (req, res) => {
    res.json({
        object: 'list',
        data: [{
            id: MODEL_NAME,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'perplexity',
            permission: [],
            root: MODEL_NAME,
            parent: null
        }]
    });
});

// ── Chat Completions ──
app.post('/v1/chat/completions', async (req, res) => {
    const { messages, model, stream, temperature, max_tokens } = req.body;

    // Validate
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
            error: {
                message: 'messages is required and must be a non-empty array',
                type: 'invalid_request_error',
                param: 'messages',
                code: 'invalid_messages'
            }
        });
    }

    // Build the query from messages (combine system + user messages)
    const query = messages
        .map(m => {
            if (m.role === 'system') return `[System: ${m.content}]`;
            if (m.role === 'user') return m.content;
            if (m.role === 'assistant') return `[Previous answer: ${m.content}]`;
            return m.content;
        })
        .join('\n\n');

    if (!query.trim()) {
        return res.status(400).json({
            error: {
                message: 'No content found in messages',
                type: 'invalid_request_error',
                param: 'messages',
                code: 'empty_content'
            }
        });
    }

    const requestModel = model || MODEL_NAME;
    const queuePosition = requestQueue.length;
    if (queuePosition > 0) {
        console.log(`📋 Request queued (position ${queuePosition})`);
    }

    // ── Streaming Response ──
    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        // Send initial role chunk
        const roleChunk = {
            id: 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 29),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestModel,
            choices: [{
                index: 0,
                delta: { role: 'assistant', content: '' },
                finish_reason: null
            }]
        };
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

        try {
            await enqueue(() => queryPerplexity(query, (chunk) => {
                // Send each incremental chunk as SSE
                if (!res.writableEnded) {
                    const sseChunk = buildStreamChunk(chunk, requestModel);
                    res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
                }
            }));

            // Send finish chunk
            if (!res.writableEnded) {
                const finishChunk = buildStreamChunk('', requestModel, 'stop');
                res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        } catch (err) {
            console.error('❌ Stream error:', err.message);
            if (!res.writableEnded) {
                const errorChunk = buildStreamChunk(`\n\n[Error: ${err.message}]`, requestModel, 'stop');
                res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        }
        return;
    }

    // ── Non-Streaming Response ──
    try {
        const result = await enqueue(() => queryPerplexity(query));
        const response = buildCompletionResponse(result.answer, requestModel, result.sources);
        res.json(response);
    } catch (err) {
        console.error('❌ Error:', err.message);
        res.status(500).json({
            error: {
                message: err.message,
                type: 'server_error',
                param: null,
                code: 'internal_error'
            }
        });
    }
});

// ── Catch-all ──
app.use((req, res) => {
    res.status(404).json({
        error: {
            message: `Unknown endpoint: ${req.method} ${req.path}`,
            type: 'invalid_request_error',
            param: null,
            code: 'unknown_endpoint'
        }
    });
});

// ─── Start Server ───────────────────────────────────────────────────────────

async function start() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║       PERPLEXITY AI - OpenAI-Compatible API Server       ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Pre-launch browser so first request is faster
    await initBrowser();

    app.listen(PORT, () => {
        console.log(`\n🚀 Server running at http://localhost:${PORT}`);
        console.log(`\n📡 Endpoints:`);
        console.log(`   POST http://localhost:${PORT}/v1/chat/completions`);
        console.log(`   GET  http://localhost:${PORT}/v1/models`);
        console.log(`   GET  http://localhost:${PORT}/health`);
        console.log(`\n💡 Example:`);
        console.log(`   curl http://localhost:${PORT}/v1/chat/completions \\`);
        console.log(`     -H "Content-Type: application/json" \\`);
        console.log(`     -d "{\\"model\\":\\"perplexity\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"What is Node.js?\\"}]}"`);
        console.log(`\n📋 Queue: requests are processed one at a time`);
        console.log('─'.repeat(60) + '\n');
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (browser) await browser.close().catch(() => { });
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (browser) await browser.close().catch(() => { });
    process.exit(0);
});

start().catch(err => {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
});
