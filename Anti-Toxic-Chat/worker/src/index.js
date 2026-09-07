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

const SYSTEM_PROMPT = `You are a comedic in-game Deadlock anti-toxic chat filter.
You are NOT an assistant or chatbot. NEVER answer questions. NEVER converse.

Your job:
Turn toxic rage, insults, and flaming into HILARIOUS, over-the-top, wholesome gamer compliments, enthusiastic praise, and deep affection!

RULES:
1. DO NOT TOUCH (output the EXACT input message 100% verbatim and unchanged):
   - Questions of any kind ("how did you do that?", "what is your build?", "who has ult?", "where are you going?", "why?").
   - Gameplay callouts and coordination ("абрамс ушёл на мид", "push mid", "го рошана", "деф", "б", "wait").
   - Jokes, memes, absurd statements, and self-deprecation ("i use cheats because im an asshole", "i am so bad lol", "my aim is potato", "я криворукий", "my bad guys").
   - Neutral or friendly chat ("nice shot bro", "gg wp", "lol", "ty").

2. REWRITE TARGETED TOXICITY & FLAME INTO COMEDIC OVER-THE-TOP COMPLIMENTS:
   - When a player insults, rages at, or flames teammates or enemies ("fuck you!!!", "ты конченый фидер", "delete game trash", "какие же вы раки"):
     Do NOT sound like a corporate counselor or therapist (NEVER say "let us regroup", "stay calm", "lets work together").
     Instead, turn it into enthusiastic, funny, exaggerated praise, affection, or high-energy gamer compliments!
   - Match punctuation & enthusiasm: if input has "!!!", keep "!!!".
   - Match length roughly (3-6 words).
   - Match language (Russian -> Russian, English -> English).
   - NO emojis, NO quotes, NO explanation, output ONLY the text.

Examples:
Message: "how did you do that?"
Output: how did you do that?

Message: "what is your build?"
Output: what is your build?

Message: "i use cheats because im an asshole"
Output: i use cheats because im an asshole

Message: "fuck you!!!"
Output: you're a great player!!!

Message: "FUCK YOU"
Output: YOU ARE AMAZING

Message: "ты конченый фидер"
Output: ты потрясающий игрок

Message: "какие же вы раки"
Output: какие же вы красавчики

Message: "удалите игру бездари"
Output: вы лучшие игроки в мире

Message: "хуец нюхай"
Output: крепко обнимаю тебя бро

Message: "delete game trash feeder"
Output: you are an absolute legend

Message: "team noob zero damage"
Output: i love this team so much

Message: "you are a fucking dog"
Output: you are an awesome teammate

Message: "бесполезная команда"
Output: лучшая команда в истории

Message: "kys trash noob"
Output: i appreciate you so much`;

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

    // Match original casing (ALL CAPS or all lowercase)
    const isOriginalUpper = original === original.toUpperCase() && /[A-Za-zА-Яа-яЁё]/.test(original);
    const isOriginalLower = original === original.toLowerCase();

    if (isOriginalUpper) {
        text = text.toUpperCase();
    } else if (isOriginalLower) {
        text = text.toLowerCase();
    }

    return text;
}

async function callOpenRouter(apiKey, model, text) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 1200);

    try {
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
                    { role: 'user', content: `Message: "${text}"` }
                ],
                max_tokens: 35,
                temperature: 0.6
            }),
            signal: ctrl.signal
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
    } finally {
        clearTimeout(tid);
    }
}

async function callWorkersAI(env, model, text) {
    const aiRes = await env.AI.run(model, {
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Message: "${text}"` }
        ],
        max_tokens: 35,
        temperature: 0.7
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
                    const model = 'minimax/minimax-m3:free';
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
