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
const MAX_TIMEOUT = 300000; // 5 minutes max per query (pro model needs time to think)
const GEMINI_URL = 'https://gemini.google.com/app';

// ─── Global State ───────────────────────────────────────────────────────────

let browser = null;
let browserReady = false;
const requestQueue = [];
let processing = false;

// ─── Browser Management ────────────────────────────────────────────────────

async function initBrowser() {
    console.log('🚀 Launching headless browser...');
    // userDataDir persists cookies/login between restarts.
    // On first run: log in to Google manually in the opened window, then all
    // future runs will reuse that session automatically.
    const userDataDir = path.join(__dirname, 'chrome-profile');
    browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,          // use real window size
        userDataDir,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu',
            '--start-maximized'
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

    // Open a regular page in the default context so it's visible in the browser window
    const page = await b.newPage();

    // Hide automation signals
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        delete navigator.__proto__.webdriver;
    });

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    );

    // Bring this tab to the front so it's visible
    await page.bringToFront();

    return { page, context: null };
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

async function extractAnswer(page, query = '') {
    return page.evaluate((inputQuery) => {
        // ── Helper: get cleaned text from an element, stripping UI chrome ──
        function cleanText(el) {
            const clone = el.cloneNode(true);
            // Remove screen-reader-only / visually-hidden nodes (e.g. "You said" spans)
            // NOTE: do NOT strip [aria-hidden="true"] broadly — it also covers real content nodes
            clone.querySelectorAll(
                '.cdk-visually-hidden, ' +
                'button, .actions, .feedback, [class*="action"], [class*="toolbar"], ' +
                '[class*="copy"], [class*="vote"], [class*="rating"], [aria-label*="Copy"]'
            ).forEach(c => c.remove());
            return (clone.innerText || clone.textContent || '').trim();
        }

        // ── Detect if model-response element exists (generation complete signal) ──
        const modelResponseExists = !!document.querySelector('model-response');

        // ── Strategy 1: model-response (appears when Gemini finishes generating) ──
        // This is the most reliable selector for the final answer.
        let answerText = '';

        if (modelResponseExists) {
            const modelEls = Array.from(document.querySelectorAll('model-response .markdown'));
            if (modelEls.length > 0) {
                const t = cleanText(modelEls[modelEls.length - 1]);
                if (t.length > answerText.length) answerText = t;
            }
            if (answerText.length < 30) {
                const modelEls2 = Array.from(document.querySelectorAll('model-response'));
                if (modelEls2.length > 0) {
                    const t = cleanText(modelEls2[modelEls2.length - 1]);
                    if (t.length > answerText.length) answerText = t;
                }
            }
        }

        // ── Strategy 2: response-container-content (live content area during streaming) ──
        // The actual div where Gemini streams response text before model-response appears.
        if (answerText.length < 30) {
            const contentEls = Array.from(document.querySelectorAll(
                '.response-container-content .markdown, ' +
                '.response-container-content message-content .markdown, ' +
                '.response-container-content'
            ));
            for (const el of contentEls) {
                // Only pick elements that are inside pending-response (not user-query)
                if (el.closest('user-query') || el.closest('[class*="user-query"]')) continue;
                const t = cleanText(el);
                if (t.length > answerText.length) answerText = t;
            }
        }

        // ── Strategy 3: message-content / markdown-main-panel ──
        if (answerText.length < 30) {
            const selectors = [
                'message-content .markdown',
                '.markdown-main-panel',
                'response-container .markdown',
                '[data-speaker="model"] .markdown',
                '[data-role="assistant"] .markdown',
                '[data-speaker="model"]',
                '[data-role="assistant"]',
            ];
            for (const sel of selectors) {
                const els = Array.from(document.querySelectorAll(sel))
                    .filter(el => !el.closest('user-query') && !el.closest('[class*="user-query"]'));
                if (els.length > 0) {
                    const t = cleanText(els[els.length - 1]);
                    if (t.length > answerText.length) answerText = t;
                }
            }
        }

        // ── Strategy 4: broad markdown fallback, strictly skipping user containers ──
        if (answerText.length < 30) {
            const els = Array.from(document.querySelectorAll('[class*="markdown"], [class*="Markdown"]'))
                .filter(el =>
                    !el.closest('user-query') &&
                    !el.closest('[class*="user-query"]') &&
                    !el.closest('.ql-editor') &&
                    !el.closest('rich-textarea') &&
                    !el.closest('[role="textbox"]')
                );
            for (const el of els) {
                const t = cleanText(el);
                if (t.length > answerText.length) answerText = t;
            }
        }

        // ── Strategy 5: last-resort — grab model-response raw innerText ──
        // For fast responses where DOM structure differs from the expected layout
        if (answerText.length < 30) {
            const el = document.querySelector('model-response');
            if (el) {
                // Clone and only strip the "You said" visually-hidden span
                const clone = el.cloneNode(true);
                clone.querySelectorAll('.cdk-visually-hidden, button').forEach(c => c.remove());
                const t = (clone.innerText || clone.textContent || '').trim();
                if (t.length > answerText.length) answerText = t;
            }
        }

        // ── Echo guard: discard text that is the user's query echoed back ──
        if (inputQuery && answerText) {
            const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
            const normAnswer = norm(answerText);
            const normQuery = norm(inputQuery);
            if (
                normAnswer === normQuery ||
                normAnswer.startsWith(normQuery.slice(0, 120)) ||
                normAnswer.startsWith('you said ' + normQuery.slice(0, 100)) ||
                normAnswer.replace(/^you said\s*/i, '').startsWith(normQuery.slice(0, 120))
            ) {
                answerText = '';
            }
        }

        // ── Detect if still generating ──
        // pending-response exists = Gemini still generating
        // model-response exists  = Gemini done generating
        const stillGenerating = !!document.querySelector('pending-response');

        const prevLen = parseInt(document.body.getAttribute('data-prev-len') || '0');
        document.body.setAttribute('data-prev-len', String(answerText.length));
        const isGrowing = answerText.length > prevLen && prevLen > 0;

        return {
            answerText,
            isLoading: stillGenerating || isGrowing,
            modelResponseExists
        };
    }, query);
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

        console.log(`[${requestId}] ⏳ Waiting for Gemini to start generating...`);

        // Wait for pending-response to appear — confirms query was received and generation started
        try {
            await page.waitForSelector('pending-response', { timeout: 60000 });
            console.log(`[${requestId}] 🟢 Generation started (pending-response detected)`);
        } catch {
            console.log(`[${requestId}] ⚠️  pending-response not seen within 30s, continuing anyway`);
        }

        // Save debug snapshot of DOM during early generation for diagnostics
        try {
            const debugHtml = await page.content();
            fs.writeFileSync(path.join(__dirname, 'debug-gemini-response.html'), debugHtml);
            console.log(`[${requestId}] 🔍 Debug snapshot saved`);

            const domAnalysis = await page.evaluate(() => {
                const tags = [
                    'model-response', 'pending-response', 'user-query',
                    'message-content', 'response-container'
                ];
                const results = [];
                for (const tag of tags) {
                    const els = document.querySelectorAll(tag);
                    if (els.length > 0) {
                        els.forEach((el, i) => {
                            const preview = (el.innerText || el.textContent || '').trim().slice(0, 80).replace(/\n/g, ' ');
                            results.push(`  ${tag}[${i}] → "${preview}"`);
                        });
                    }
                }
                return results.length ? results.join('\n') : '  (no expected elements found)';
            });
            console.log(`[${requestId}] 🗂️  DOM analysis:\n${domAnalysis}`);
        } catch { /* non-fatal */ }

        // Wait for model-response to appear OR pending-response to disappear
        // — either event signals that Gemini has finished generating
        console.log(`[${requestId}] ⏳ Waiting for generation to complete (model-response)...`);
        try {
            await page.waitForFunction(
                () => !!document.querySelector('model-response') || !document.querySelector('pending-response'),
                { timeout: MAX_TIMEOUT - 65000, polling: 500 }
            );
            console.log(`[${requestId}] 🏁 Generation complete signal received`);
        } catch {
            console.log(`[${requestId}] ⚠️  Generation complete signal timed out, extracting whatever is available`);
        }

        // Give the DOM a moment to settle after generation completes
        // (especially important for fast/short responses where model-response
        //  appears almost immediately after pending-response disappears)
        await new Promise(r => setTimeout(r, 800));

        const start = Date.now();
        let lastText = '';
        let stableCount = 0;
        let lastChunkedLength = 0;

        // Poll for stable answer text (handles both streaming and final state)
        while (Date.now() - start < 120000) {
            const extraction = await extractAnswer(page, query);

            if (extraction.answerText && extraction.answerText.length > 10) {
                console.log(`[${requestId}] 📝 Extracted ${extraction.answerText.length} chars, loading=${extraction.isLoading}, modelDone=${extraction.modelResponseExists}, preview="${extraction.answerText.slice(0, 80).replace(/\n/g, ' ')}"`);

                if (onChunk && extraction.answerText.length > lastChunkedLength) {
                    const newContent = extraction.answerText.slice(lastChunkedLength);
                    onChunk(newContent);
                    lastChunkedLength = extraction.answerText.length;
                }

                if (extraction.answerText === lastText) {
                    stableCount++;
                    // Stable for 2s when model-response exists, or 5s otherwise, or 10s regardless
                    const doneThreshold = extraction.modelResponseExists ? 2 : 5;
                    if ((!extraction.isLoading && stableCount >= doneThreshold) || stableCount >= 10) {
                        console.log(`[${requestId}] ✅ Answer complete (${extraction.answerText.length} chars)`);
                        return { answer: extraction.answerText };
                    }
                } else {
                    stableCount = 0;
                }
                lastText = extraction.answerText;
            } else if (extraction.modelResponseExists && lastText) {
                // model-response exists but extraction found nothing — fall back to lastText
                console.log(`[${requestId}] ✅ model-response present, using last extracted text`);
                return { answer: lastText };
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        if (lastText) {
            console.log(`[${requestId}] ⏰ Timeout, returning partial answer`);
            return { answer: lastText };
        }

        throw new Error('Timeout: no answer received from Gemini');

    } finally {
        await page.close().catch(() => { });
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
