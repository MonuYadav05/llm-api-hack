/**
 * Google Gemini - OpenAI-Compatible API Server (No Login Required)
 *
 * Exposes Google Gemini as a standard OpenAI-compatible REST API.
 * Uses a persistent headless browser to query gemini.google.com.
 *
 * Usage:
 *   node gemini-server.js
 *   # Server starts on port 3001 (or GEMINI_PORT / PORT env var)
 *
 * Endpoints:
 *   POST /v1/chat/completions   — OpenAI-compatible chat completions
 *   GET  /v1/models             — List available models
 *   GET  /health                — Health check
 *
 * Example:
 *   curl http://localhost:3001/v1/chat/completions \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"gemini","messages":[{"role":"user","content":"What is Node.js?"}]}'
 */

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.GEMINI_PORT || process.env.PORT || '3001', 10);
const MODEL_NAME = 'gemini';
const MAX_TIMEOUT = 120000; // 2 minutes max per query
const GEMINI_URL = 'https://gemini.google.com/app';

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

    // Use an incognito browser context for each request
    // so we always get a fresh Gemini homepage
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

// ─── Submit Query ───────────────────────────────────────────────────────────

async function submitQuery(page, query) {
    await new Promise(r => setTimeout(r, 2000));

    // Scroll to bottom in case input is at the bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 500));

    // Gemini uses various input selectors depending on version
    const selectors = [
        '.ql-editor',                      // Quill editor (common in Gemini)
        'rich-textarea .ql-editor',        // Rich textarea wrapper
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

                // Try clicking the send button first, fallback to Enter
                const sendClicked = await page.evaluate(() => {
                    // Look for send/submit button
                    const sendSelectors = [
                        'button[aria-label*="Send" i]',
                        'button[aria-label*="Submit" i]',
                        '.send-button',
                        'button.send-button',
                        '[data-mat-icon-name="send"]',
                        'mat-icon[data-mat-icon-name="send"]',
                        'button mat-icon',
                    ];
                    for (const sel of sendSelectors) {
                        const btn = document.querySelector(sel);
                        if (btn) {
                            // Find the closest button if we matched an icon inside
                            const actualBtn = btn.closest('button') || btn;
                            actualBtn.click();
                            return true;
                        }
                    }
                    // Fallback: find any button near the input area
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                        if (ariaLabel.includes('send') || ariaLabel.includes('submit')) {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                });

                if (!sendClicked) {
                    await page.keyboard.press('Enter');
                }

                return true;
            }
        } catch {
            continue;
        }
    }

    return false;
}

// ─── Extract Answer from Gemini DOM ─────────────────────────────────────────

async function extractAnswer(page) {
    return page.evaluate(() => {
        // Gemini renders responses in various container elements.
        // We look for the LAST response block (the newest answer).
        const responseSelectors = [
            'message-content .markdown',           // Main markdown response
            'model-response .markdown',             // Model response container
            '.response-container .markdown',
            '.model-response-text',
            '.response-content',
            '[class*="response"] .markdown',
            '.markdown-main-panel',
            'message-content',                      // Fallback without .markdown
            'model-response',
        ];

        let answerText = '';

        for (const sel of responseSelectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
                // Get the LAST response element (newest answer)
                const el = els[els.length - 1];
                const clone = el.cloneNode(true);

                // Remove any action buttons, feedback icons, copy buttons etc.
                clone.querySelectorAll(
                    'button, .actions, .feedback, [class*="action"], [class*="toolbar"], [class*="copy"]'
                ).forEach(c => c.remove());

                const text = (clone.innerText || clone.textContent || '').trim();
                if (text.length > answerText.length) {
                    answerText = text;
                }
            }
        }

        // Broader fallback: look for any large text block that appeared
        if (answerText.length < 30) {
            const fallbackSels = [
                '[class*="markdown"]',
                '[class*="Markdown"]',
                '[class*="response"]',
                '[class*="Response"]',
                '[class*="answer"]',
                '.conversation-container',
            ];
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

        // Detect loading state
        const isLoading = !!(
            document.querySelector('[class*="loading"]') ||
            document.querySelector('[class*="typing"]') ||
            document.querySelector('[class*="spinner"]') ||
            document.querySelector('[class*="Spinner"]') ||
            document.querySelector('[class*="progress"]') ||
            document.querySelector('mat-progress-bar') ||
            document.querySelector('.loading-indicator') ||
            // Gemini specific: the "thinking" animation
            document.querySelector('[class*="thinking"]') ||
            document.querySelector('[class*="generating"]')
        );

        const prevLen = parseInt(document.body.getAttribute('data-prev-len') || '0');
        document.body.setAttribute('data-prev-len', String(answerText.length));
        const isGrowing = answerText.length > prevLen && prevLen > 0;

        return { answerText, isLoading: isLoading || isGrowing };
    });
}

// ─── Query Gemini ───────────────────────────────────────────────────────────

async function queryGemini(query, onChunk = null) {
    const { page, context } = await createPage();
    const requestId = crypto.randomUUID();

    try {
        console.log(`[${requestId}] 🌐 Navigating to Gemini...`);
        await page.goto(GEMINI_URL, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        await new Promise(r => setTimeout(r, 2000));

        // Dismiss any initial dialogs/modals
        await page.evaluate(() => {
            const dismissSelectors = [
                'button[aria-label="Close"]',
                'button[aria-label="Dismiss"]',
                'button[aria-label="Got it"]',
                '[class*="dismiss"]',
                '[class*="close-button"]',
            ];
            for (const sel of dismissSelectors) {
                const btn = document.querySelector(sel);
                if (btn) btn.click();
            }
        });
        await new Promise(r => setTimeout(r, 500));

        console.log(`[${requestId}] 🔄 Submitting query...`);
        const submitted = await submitQuery(page, query);
        if (!submitted) {
            // Debug: save page HTML for analysis
            const html = await page.content();
            fs.writeFileSync(path.join(__dirname, 'debug-gemini.html'), html);
            console.log(`[${requestId}] 🐛 Debug HTML saved to debug-gemini.html`);
            throw new Error('Could not find input field on Gemini page');
        }

        console.log(`[${requestId}] ⏳ Waiting for answer...`);

        const start = Date.now();
        let lastText = '';
        let stableCount = 0;
        let lastChunkedLength = 0;

        // Wait for Gemini to start generating
        await new Promise(r => setTimeout(r, 5000));

        while (Date.now() - start < MAX_TIMEOUT) {
            const extraction = await extractAnswer(page);

            if (extraction.answerText && extraction.answerText.length > 10) {
                // Send incremental chunks for streaming
                if (onChunk && extraction.answerText.length > lastChunkedLength) {
                    const newContent = extraction.answerText.slice(lastChunkedLength);
                    onChunk(newContent);
                    lastChunkedLength = extraction.answerText.length;
                }

                if (extraction.answerText === lastText) {
                    stableCount++;
                    // Stable for 3s and not loading, or 10s regardless
                    if ((!extraction.isLoading && stableCount >= 3) || stableCount >= 10) {
                        console.log(`[${requestId}] ✅ Answer complete (${extraction.answerText.length} chars)`);
                        return { answer: extraction.answerText };
                    }
                } else {
                    stableCount = 0;
                }
                lastText = extraction.answerText;
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        if (lastText) {
            console.log(`[${requestId}] ⏰ Timeout, returning partial answer`);
            return { answer: lastText };
        }

        throw new Error('Timeout: no answer received from Gemini');

    } finally {
        await page.close().catch(() => { }); await context.close().catch(() => { });
    }
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

function buildCompletionResponse(content, model) {
    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 29);
    return {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || MODEL_NAME,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content
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
            owned_by: 'google',
            permission: [],
            root: MODEL_NAME,
            parent: null
        }]
    });
});

// ── Chat Completions ──
app.post('/v1/chat/completions', async (req, res) => {
    const { messages, model, stream } = req.body;

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

    // Build query from messages
    const query = messages
        .map(m => {
            if (m.role === 'system') return `[System instruction: ${m.content}]`;
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

    // ── Streaming ──
    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

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
            await enqueue(() => queryGemini(query, (chunk) => {
                if (!res.writableEnded) {
                    const sseChunk = buildStreamChunk(chunk, requestModel);
                    res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
                }
            }));

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

    // ── Non-Streaming ──
    try {
        const result = await enqueue(() => queryGemini(query));
        const response = buildCompletionResponse(result.answer, requestModel);
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
    console.log('║    GOOGLE GEMINI - OpenAI-Compatible API Server            ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

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
        console.log(`     -d "{\\"model\\":\\"gemini\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"What is Node.js?\\"}]}"`);
        console.log(`\n📋 Queue: requests are processed one at a time`);
        console.log('─'.repeat(60) + '\n');
    });
}

// ─── Entry Point ────────────────────────────────────────────────────────────

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
