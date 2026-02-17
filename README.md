# Perplexity AI API Client

A JavaScript client for interacting with Perplexity AI's API using Server-Sent Events (SSE).

## Features

- ✅ Handles SSE streaming responses
- ✅ Beautiful formatted console output
- ✅ Configurable model preferences
- ✅ Easy to use API

## Installation

No external dependencies required for Node.js 18+. For older versions, you might need to install `node-fetch`.

## Usage

### Basic Usage

```javascript
const { askPerplexity } = require('./perplexity-api');

async function example() {
    const result = await askPerplexity('What is artificial intelligence?', {
        cookies: 'your-session-cookies-here',
        model: 'claude45sonnet'
    });
    
    console.log('Full answer:', result.answer);
    console.log('Sources:', result.sources);
}

example();
```

### Command Line Usage

```bash
# Using environment variable for cookies
export PERPLEXITY_COOKIES="pplx.session-id=...; __Secure-next-auth.session-token=..."
node perplexity-api.js "Your question here"

# Or pass the query directly
node perplexity-api.js "What is the meaning of life?"
```

### Advanced Options

```javascript
await askPerplexity('Your question', {
    // Required: Your session cookies from perplexity.ai
    cookies: 'pplx.session-id=...; __Secure-next-auth.session-token=...',
    
    // Optional: Model preference
    model: 'claude45sonnet', // or 'gpt4', etc.
    
    // Optional: Custom UUIDs
    frontendUuid: 'custom-uuid',
    requestId: 'custom-request-id',
    
    // Optional: Query source
    querySource: 'followup', // or 'default', 'user', etc.
    
    // Optional: Override any params
    customParams: {
        search_focus: 'internet',
        sources: ['web'],
        mode: 'copilot'
    }
});
```

## Getting Cookies

**Important**: You need valid session cookies from perplexity.ai to use this API.

1. Open https://www.perplexity.ai in your browser
2. Log in to your account
3. Open Developer Tools (F12)
4. Go to the Network tab
5. Make a search query
6. Find the request to `/rest/sse/perplexity_ask`
7. Copy the `Cookie` header value
8. Use it in your code or set it as an environment variable

### Required Cookies:
- `pplx.session-id`
- `__Secure-next-auth.session-token`
- `__cf_bm`
- `cf_clearance`

## Response Format

The function returns an object with:

```javascript
{
    answer: 'The complete answer text...',
    sources: [
        'https://source1.com',
        'https://source2.com'
    ],
    metadata: {
        // Additional metadata from the API
    }
}
```

## Output Example

```
╔════════════════════════════════════════════════════════╗
║         PERPLEXITY AI RESPONSE                         ║
╚════════════════════════════════════════════════════════╝

📝 Query: What is artificial intelligence?

────────────────────────────────────────────────────────
🔄 Streaming response...

Artificial intelligence (AI) is the simulation of human intelligence...
[Response streams here in real-time]

────────────────────────────────────────────────────────
✅ Stream completed

╔════════════════════════════════════════════════════════╗
║         FINAL RESPONSE                                 ║
╚════════════════════════════════════════════════════════╝

📄 Answer:
Artificial intelligence (AI) is the simulation of human intelligence...

🔗 Sources:
  1. https://example.com/ai-explained
  2. https://example.com/what-is-ai
```

## Notes

- This API requires authentication via session cookies
- Cookies expire after some time and need to be refreshed
- Respect Perplexity's terms of service and rate limits
- The API endpoint and structure may change without notice

## License

MIT
