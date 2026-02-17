/**
 * Unified LLM API Server (No Login Required)
 *
 * Single OpenAI-compatible server that supports multiple LLM backends.
 * Just change the "model" field in your request to switch between them.
 *
 * Supported models:
 *   - "perplexity"  → queries perplexity.ai
 *   - "gemini"      → queries gemini.google.com
 *
 * Usage:
 *   node server.js
 *   # Server starts on port 3000 (or PORT env var)
 *
 * Examples:
 *   curl http://localhost:3000/v1/chat/completions \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"perplexity","messages":[{"role":"user","content":"What is Node.js?"}]}'
 *
 *   curl http://localhost:3000/v1/chat/completions \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"gemini","messages":[{"role":"user","content":"What is Node.js?"}]}'
 */

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_TIMEOUT = 120000; // 2 minutes max per query
const DEFAULT_MODEL = 'perplexity';

const SUPPORTED_MODELS = {
    perplexity: { name: 'perplexity', owned_by: 'perplexity', url: 'https://www.perplexity.ai/' },
    gemini:     { name: 'gemini',     owned_by: 'google',     url: 'https://gemini.google.com/app' },
};

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
    const context = await b.createBrowserContext();
    const page = await context.newPage();

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        delete navigator.__proto__.webdriver;
    });

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    );

    return { page, context };
}

// ═══════════════════════════════════════════════════════════════════════════
//  PERPLEXITY BACKEND
// ═══════════════════════════════════════════════════════════════════════════

async function perplexitySubmit(page, query) {
    await new Promise(r => setTimeout(r, 2000));
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
                await page.keyboard.down('Control');
                await page.keyboard.press('a');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 200));

                const client = await page.createCDPSession();
                await client.send('Input.insertText', { text: query });
                await client.detach();
                await new Promise(r => setTimeout(r, 500));
                await page.keyboard.press('Enter');
                return true;
            }
        } catch { continue; }
    }
    return false;
}

async function perplexityExtract(page) {
    return page.evaluate(() => {
        const proseEls = document.querySelectorAll('.prose.dark\\:prose-invert');
        let paragraphs = [];
        for (const el of proseEls) {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('.citation, .citation-nbsp, [class*="SeeMore"]').forEach(c => c.remove());
            const text = (clone.innerText || clone.textContent || '').trim();
            if (text.length > 5) paragraphs.push(text);
        }
        let answerText = paragraphs.join('\n\n');

        if (answerText.length < 30) {
            const fallbackSels = ['[class*="MarkdownBlock"]', '[class*="answer"]', '[class*="response"]', '[data-testid*="answer"]', 'article', 'main'];
            for (const sel of fallbackSels) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const clone = el.cloneNode(true);
                    clone.querySelectorAll('.citation, .citation-nbsp, [class*="SeeMore"]').forEach(c => c.remove());
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
            const label = el.closest('[aria-label]')?.getAttribute('aria-label') || el.textContent?.trim() || '';
            if (url && !seen.has(url)) { seen.add(url); sources.push({ title: label || url, url }); }
        }
        if (sources.length === 0) {
            const links = document.querySelectorAll('a[href^="http"]:not([href*="perplexity.ai"]):not([href*="google.com"])');
            for (const a of links) {
                const url = a.href; const title = a.textContent?.trim() || '';
                if (url && !seen.has(url) && title.length > 2 && title.length < 200) { seen.add(url); sources.push({ title, url }); }
            }
        }

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

async function queryPerplexity(query, onChunk = null) {
    const { page, context } = await createPage();
    const requestId = crypto.randomUUID().slice(0, 8);

    try {
        console.log(`[perplexity:${requestId}] 🌐 Navigating...`);
        await page.goto('https://www.perplexity.ai/', { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000));

        console.log(`[perplexity:${requestId}] 🔄 Submitting query...`);
        if (!(await perplexitySubmit(page, query))) {
            throw new Error('Could not find input field on Perplexity page');
        }

        console.log(`[perplexity:${requestId}] ⏳ Waiting for answer...`);
        const start = Date.now();
        let lastText = '', stableCount = 0, lastChunkedLength = 0;
        await new Promise(r => setTimeout(r, 5000));

        while (Date.now() - start < MAX_TIMEOUT) {
            const ext = await perplexityExtract(page);
            if (ext.answerText) {
                if (onChunk && ext.answerText.length > lastChunkedLength) {
                    onChunk(ext.answerText.slice(lastChunkedLength));
                    lastChunkedLength = ext.answerText.length;
                }
                if (ext.answerText === lastText) {
                    stableCount++;
                    if ((!ext.isLoading && stableCount >= 3) || stableCount >= 8) {
                        console.log(`[perplexity:${requestId}] ✅ Done (${ext.answerText.length} chars)`);
                        return { answer: ext.answerText, sources: ext.sources };
                    }
                } else { stableCount = 0; }
                lastText = ext.answerText;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        if (lastText) return { answer: lastText, sources: [] };
        throw new Error('Timeout: no answer from Perplexity');
    } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  GEMINI BACKEND
// ═══════════════════════════════════════════════════════════════════════════

async function geminiSubmit(page, query) {
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 500));

    const selectors = [
        '.ql-editor',
        'rich-textarea .ql-editor',
        'rich-textarea [contenteditable="true"]',
        '[contenteditable="true"]',
        'textarea',
        '[aria-label*="prompt" i]',
        '[aria-label*="Enter a prompt" i]',
        '[placeholder*="Enter a prompt" i]',
        '[placeholder*="Ask Gemini" i]',
        'input[type="text"]',
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
                        && style.opacity !== '0'
                        && rect.height > 0
                        && rect.width > 0;
                });
                if (!isVisible) continue;

                await element.click();
                await new Promise(r => setTimeout(r, 300));
                await page.keyboard.down('Control');
                await page.keyboard.press('a');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 200));

                const client = await page.createCDPSession();
                await client.send('Input.insertText', { text: query });
                await client.detach();
                await new Promise(r => setTimeout(r, 500));

                // Try send button first, fallback to Enter
                const sendClicked = await page.evaluate(() => {
                    const sels = [
                        'button[aria-label*="Send" i]', 'button[aria-label*="Submit" i]',
                        '.send-button', '[data-mat-icon-name="send"]',
                    ];
                    for (const sel of sels) {
                        const btn = document.querySelector(sel);
                        if (btn) { (btn.closest('button') || btn).click(); return true; }
                    }
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        const al = (btn.getAttribute('aria-label') || '').toLowerCase();
                        if (al.includes('send') || al.includes('submit')) { btn.click(); return true; }
                    }
                    return false;
                });
                if (!sendClicked) await page.keyboard.press('Enter');
                return true;
            }
        } catch { continue; }
    }
    return false;
}

async function geminiExtract(page) {
    return page.evaluate(() => {
        const responseSelectors = [
            'message-content .markdown', 'model-response .markdown',
            '.response-container .markdown', '.model-response-text',
            '.response-content', '[class*="response"] .markdown',
            '.markdown-main-panel', 'message-content', 'model-response',
        ];

        let answerText = '';
        for (const sel of responseSelectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
                const el = els[els.length - 1];
                const clone = el.cloneNode(true);
                clone.querySelectorAll('button, .actions, .feedback, [class*="action"], [class*="toolbar"], [class*="copy"]').forEach(c => c.remove());
                const text = (clone.innerText || clone.textContent || '').trim();
                if (text.length > answerText.length) answerText = text;
            }
        }

        if (answerText.length < 30) {
            const fallbackSels = ['[class*="markdown"]', '[class*="Markdown"]', '[class*="response"]', '[class*="Response"]', '[class*="answer"]', '.conversation-container'];
            for (const sel of fallbackSels) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const clone = el.cloneNode(true);
                    clone.querySelectorAll('button, .actions').forEach(c => c.remove());
                    const t = (clone.innerText || '').trim();
                    if (t.length > answerText.length) answerText = t;
                }
            }
        }

        const isLoading = !!(
            document.querySelector('[class*="loading"]') || document.querySelector('[class*="typing"]') ||
            document.querySelector('[class*="spinner"]') || document.querySelector('[class*="Spinner"]') ||
            document.querySelector('[class*="progress"]') || document.querySelector('mat-progress-bar') ||
            document.querySelector('[class*="thinking"]') || document.querySelector('[class*="generating"]')
        );
        const prevLen = parseInt(document.body.getAttribute('data-prev-len') || '0');
        document.body.setAttribute('data-prev-len', String(answerText.length));
        const isGrowing = answerText.length > prevLen && prevLen > 0;

        return { answerText, isLoading: isLoading || isGrowing };
    });
}

async function queryGemini(query, onChunk = null) {
    const { page, context } = await createPage();
    const requestId = crypto.randomUUID().slice(0, 8);

    try {
        console.log(`[gemini:${requestId}] 🌐 Navigating...`);
        await page.goto('https://gemini.google.com/app', { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000));

        // Dismiss any initial dialogs
        await page.evaluate(() => {
            ['button[aria-label="Close"]', 'button[aria-label="Dismiss"]', 'button[aria-label="Got it"]',
             '[class*="dismiss"]', '[class*="close-button"]'].forEach(sel => {
                const btn = document.querySelector(sel);
                if (btn) btn.click();
            });
        });
        await new Promise(r => setTimeout(r, 500));

        console.log(`[gemini:${requestId}] 🔄 Submitting query...`);
        if (!(await geminiSubmit(page, query))) {
            const html = await page.content();
            fs.writeFileSync(path.join(__dirname, 'debug-gemini.html'), html);
            throw new Error('Could not find input field on Gemini page');
        }

        console.log(`[gemini:${requestId}] ⏳ Waiting for answer...`);
        const start = Date.now();
        let lastText = '', stableCount = 0, lastChunkedLength = 0;
        await new Promise(r => setTimeout(r, 5000));

        while (Date.now() - start < MAX_TIMEOUT) {
            const ext = await geminiExtract(page);
            if (ext.answerText && ext.answerText.length > 10) {
                if (onChunk && ext.answerText.length > lastChunkedLength) {
                    onChunk(ext.answerText.slice(lastChunkedLength));
                    lastChunkedLength = ext.answerText.length;
                }
                if (ext.answerText === lastText) {
                    stableCount++;
                    if ((!ext.isLoading && stableCount >= 3) || stableCount >= 10) {
                        console.log(`[gemini:${requestId}] ✅ Done (${ext.answerText.length} chars)`);
                        return { answer: ext.answerText, sources: [] };
                    }
                } else { stableCount = 0; }
                lastText = ext.answerText;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        if (lastText) return { answer: lastText, sources: [] };
        throw new Error('Timeout: no answer from Gemini');
    } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MODEL ROUTER — pick backend based on model name
// ═══════════════════════════════════════════════════════════════════════════

function getQueryFn(modelName) {
    const model = (modelName || DEFAULT_MODEL).toLowerCase().trim();
    if (model.includes('perplexity') || model === 'pplx') return queryPerplexity;
    if (model.includes('gemini'))                          return queryGemini;
    return null;
}

// ─── Request Queue ──────────────────────────────────────────────────────────

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
    try { resolve(await task()); }
    catch (err) { reject(err); }
    finally {
        processing = false;
        if (requestQueue.length > 0) processQueue();
    }
}

// ─── OpenAI Format Helpers ──────────────────────────────────────────────────

function buildCompletionResponse(content, model, sources = []) {
    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 29);
    let fullContent = content;
    if (sources.length > 0) {
        fullContent += '\n\n---\n**Sources:**\n';
        sources.forEach((src, i) => { fullContent += `${i + 1}. [${src.title}](${src.url})\n`; });
    }
    return {
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
}

function buildStreamChunk(content, model, finishReason = null) {
    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 29);
    return {
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: finishReason ? {} : { content }, finish_reason: finishReason }]
    };
}

// ─── Express Server ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

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
        models: Object.keys(SUPPORTED_MODELS),
        queueLength: requestQueue.length,
        processing
    });
});

// ── List Models ──
app.get('/v1/models', (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    res.json({
        object: 'list',
        data: Object.values(SUPPORTED_MODELS).map(m => ({
            id: m.name, object: 'model', created: now,
            owned_by: m.owned_by, permission: [], root: m.name, parent: null
        }))
    });
});

// ── Chat Completions ──
app.post('/v1/chat/completions', async (req, res) => {
    const { messages, model, stream } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
            error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error', param: 'messages', code: 'invalid_messages' }
        });
    }

    const requestModel = model || DEFAULT_MODEL;
    const queryFn = getQueryFn(requestModel);

    if (!queryFn) {
        return res.status(400).json({
            error: {
                message: `Unsupported model: "${requestModel}". Available: ${Object.keys(SUPPORTED_MODELS).join(', ')}`,
                type: 'invalid_request_error', param: 'model', code: 'model_not_found'
            }
        });
    }

    const query = messages.map(m => {
        if (m.role === 'system') return `[System: ${m.content}]`;
        if (m.role === 'user') return m.content;
        if (m.role === 'assistant') return `[Previous answer: ${m.content}]`;
        return m.content;
    }).join('\n\n');

    if (!query.trim()) {
        return res.status(400).json({
            error: { message: 'No content found in messages', type: 'invalid_request_error', param: 'messages', code: 'empty_content' }
        });
    }

    const queuePos = requestQueue.length;
    if (queuePos > 0) console.log(`📋 Request queued (position ${queuePos})`);

    // ── Streaming ──
    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const roleChunk = {
            id: 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 29),
            object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestModel,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
        };
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

        try {
            await enqueue(() => queryFn(query, (chunk) => {
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify(buildStreamChunk(chunk, requestModel))}\n\n`);
                }
            }));
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(buildStreamChunk('', requestModel, 'stop'))}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        } catch (err) {
            console.error('❌ Stream error:', err.message);
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(buildStreamChunk(`\n\n[Error: ${err.message}]`, requestModel, 'stop'))}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        }
        return;
    }

    // ── Non-Streaming ──
    try {
        const result = await enqueue(() => queryFn(query));
        res.json(buildCompletionResponse(result.answer, requestModel, result.sources || []));
    } catch (err) {
        console.error('❌ Error:', err.message);
        res.status(500).json({
            error: { message: err.message, type: 'server_error', param: null, code: 'internal_error' }
        });
    }
});

// ── Catch-all ──
app.use((req, res) => {
    res.status(404).json({
        error: { message: `Unknown endpoint: ${req.method} ${req.path}`, type: 'invalid_request_error', param: null, code: 'unknown_endpoint' }
    });
});

// ─── Start Server ───────────────────────────────────────────────────────────

async function start() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║     Unified LLM API Server (OpenAI-Compatible)           ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    await initBrowser();

    app.listen(PORT, () => {
        console.log(`\n🚀 Server running at http://localhost:${PORT}`);
        console.log(`\n📡 Endpoints:`);
        console.log(`   POST http://localhost:${PORT}/v1/chat/completions`);
        console.log(`   GET  http://localhost:${PORT}/v1/models`);
        console.log(`   GET  http://localhost:${PORT}/health`);
        console.log(`\n🤖 Supported models: ${Object.keys(SUPPORTED_MODELS).join(', ')}`);
        console.log(`\n💡 Examples:`);
        console.log(`   curl http://localhost:${PORT}/v1/chat/completions -H "Content-Type: application/json" -d "{\\"model\\":\\"perplexity\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Hello\\"}]}"`);
        console.log(`   curl http://localhost:${PORT}/v1/chat/completions -H "Content-Type: application/json" -d "{\\"model\\":\\"gemini\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Hello\\"}]}"`);
        console.log(`\n📋 Queue: requests are processed one at a time`);
        console.log('─'.repeat(60) + '\n');
    });
}

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
});

start().catch(err => {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
});
