/**
 * Anti-Toxic-Chat Cloudflare Worker
 * Primary: OpenRouter (MiniMax M3 Free)
 * Fallback: Cloudflare Workers AI (Meta Llama 3.3 70B)
 */

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

const SYSTEM_PROMPT = `You are an in-game Deadlock anti-toxic chat filter.
Your job:
1. FIRST, determine if the message is toxic, abusive, an insult, whining, or frustrated.
2. IF NOT TOXIC (neutral, friendly, polite, game callouts like hero names, lanes, coordination, "ok cool", "push mid", "абрамс ушёл", "лэш отдай лес", "го рошана", "деф", "б", "wait"):
   You MUST return the exact message unchanged, verbatim! Do NOT rewrite neutral or non-toxic messages.
3. ONLY IF TOXIC (insults, flame, rage, blaming teammates, swearing at someone):
   Rewrite it into wholesome, friendly encouraging gamer banter or a compliment.
   - VARIETY IS CRITICAL: NEVER repeat the cliche "you are a great player" or "ты отличный игрок"! Use diverse, natural gamer phrases matching the context.
   - EXACT length matching: roughly the same number of words (3-6 words, never write long essays).
   - EXACT case matching: if input is lowercase, output MUST be 100% lowercase. If uppercase, uppercase.
   - NO emojis, NO stars, NO quotes, NO explanation, NO preamble.
   - Keep the same language (Russian -> Russian, English -> English).
   - Output ONLY the rewritten text.

Examples:
Input: абрамс ушёл
Output: абрамс ушёл

Input: лэш отдай лес
Output: лэш отдай лес

Input: push mid guys
Output: push mid guys

Input: gg wp
Output: gg wp

Input: ты конченый фидер удали игру
Output: соберись бро мы еще камбэкнем

Input: какие же вы раки
Output: отличный трай додавим в следующий раз

Input: хуец нюхай
Output: красиво сыграно хорош

Input: you are a fucking dog ass bitch
Output: solid play let us focus up

Input: kys trash noob
Output: nice try team we got this

Input: team noob zero damage
Output: good effort team nice fight`;

function sanitizeOutput(raw, original) {
    if (!raw) return '';
    let text = raw.trim();

    // Strip leading "Output:", "Here is...", etc.
    text = text.replace(/^(output|result|response|here is.*?):\s*/i, '');
    // Strip surrounding quotes
    text = text.replace(/^["'«“](.*)["'»”]$/s, '$1').trim();
    // Strip markdown formatting (*, _, ~, `)
    text = text.replace(/[*_~`]/g, '');
    // Strip emojis / decorative symbols
    text = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}🌟⭐✨]/gu, '').trim();

    // Match original casing if original was lowercase
    if (original && original === original.toLowerCase()) {
        text = text.toLowerCase();
    }

    return text;
}

async function callOpenRouter(apiKey, model, text) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/Predi-i/Anti-Toxic-Chat',
            'X-Title': 'Anti-Toxic-Chat'
        },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: text }
            ],
            max_tokens: 35,
            temperature: 0.6
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        const cfRay = res.headers.get('cf-ray') || 'unknown';
        throw new Error(`OpenRouter ${model} HTTP ${res.status} [ray: ${cfRay}]: ${errText.slice(0, 120)}`);
    }

    const data = await res.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error(`OpenRouter ${model} returned empty response`);
    }

    return data.choices[0].message.content || '';
}

async function callWorkersAI(env, model, text) {
    const aiRes = await env.AI.run(model, {
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text }
        ],
        max_tokens: 35,
        temperature: 0.6
    });

    return (aiRes && aiRes.response) ? aiRes.response : '';
}

export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);

            if (request.method === 'OPTIONS') {
                return new Response(null, { headers: CORS_HEADERS });
            }

            if (url.pathname === '/ping' || url.pathname === '/api/ping') {
                return new Response(JSON.stringify({ status: 'ok', worker: 'anti-toxic-chat' }), {
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                });
            }

            if (url.pathname === '/api/transform' && request.method === 'POST') {
                let body;
                try {
                    body = await request.json();
                } catch (e) {
                    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
                        status: 400,
                        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                    });
                }

                const rawText = (body && body.text) ? String(body.text).trim() : '';
                if (!rawText) {
                    return new Response(JSON.stringify({ text: '' }), {
                        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                    });
                }

                let errors = {};

                // -------------------------------------------------------------
                // 1. PRIMARY: OpenRouter (MiniMax M3 Free)
                // -------------------------------------------------------------
                const openRouterKey = env.OPENROUTER_API_KEY;
                if (openRouterKey) {
                    const models = [
                        'minimax/minimax-m3:free',
                        'openrouter/free'
                    ];
                    for (const model of models) {
                        try {
                            const rawReply = await callOpenRouter(openRouterKey, model, rawText);
                            const cleanReply = sanitizeOutput(rawReply, rawText);
                            if (cleanReply) {
                                return new Response(JSON.stringify({
                                    original: rawText,
                                    text: cleanReply,
                                    provider: model
                                }), {
                                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                                });
                            }
                        } catch (e) {
                            errors[model] = e.message;
                        }
                    }
                }

                // -------------------------------------------------------------
                // 2. FALLBACK: Cloudflare Workers AI (Meta Llama 3.3 70B)
                // -------------------------------------------------------------
                if (env.AI) {
                    const cfModel = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
                    try {
                        const rawReply = await callWorkersAI(env, cfModel, rawText);
                        const cleanReply = sanitizeOutput(rawReply, rawText);
                        if (cleanReply) {
                            return new Response(JSON.stringify({
                                original: rawText,
                                text: cleanReply,
                                provider: cfModel
                            }), {
                                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                            });
                        }
                    } catch (e) {
                        errors[cfModel] = e.message;
                    }
                }

                // If all providers failed, safely return original text with 502
                return new Response(JSON.stringify({
                    error: 'All AI providers failed',
                    details: errors,
                    fallback: rawText
                }), {
                    status: 502,
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                });
            }

            return new Response('Not found', { status: 404, headers: CORS_HEADERS });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
                status: 500,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }
    }
};
