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

const SYSTEM_PROMPT = `You are an automated text sanitizer for in-game Deadlock chat messages between players.
You are NOT a chatbot. You are NOT an assistant.
You do NOT answer questions. You do NOT converse with players.

Your ONLY job is to neutralize toxic hostility directed at other players.

RULES:
1. DO NOT REWRITE (output the EXACT input message verbatim and unchanged):
   - Questions of any kind ("how did you do that?", "is taiwan part of china?", "who has ult?", "where are you going?", "why?").
   - Gameplay callouts and coordination ("абрамс ушёл на мид", "push mid", "го рошана", "деф", "б", "wait").
   - Jokes, memes, absurd statements, and self-deprecation ("i use cheats because im gay", "i am so bad lol", "my aim is potato", "я криворукий", "my bad guys").
   - Polite, casual, neutral, or friendly chat ("nice shot bro", "gg wp", "lol", "thanks").

2. ONLY REWRITE TARGETED TOXICITY DIRECTED AT OTHERS:
   - When a player insults, flames, blames, or abuses teammates or opponents ("ты конченый фидер удали игру", "какие же вы раки", "delete game trash feeder", "fuck you bitch", "бесполезная команда", "соси хуй", "nigger kys").
   - Rewrite it into a short, friendly, wholesome gamer remark in the same language.
   - Context-sensitive variety: DO NOT repeat the same cliché phrase for every input! Match the context naturally.
   - Roughly same length (3-6 words), exact casing (lowercase -> lowercase), NO emojis, NO quotes, NO explanation.

Examples:
Input: how did you do that?
Output: how did you do that?

Input: is taiwan part of china?
Output: is taiwan part of china?

Input: i use cheats because im gay
Output: i use cheats because im gay

Input: who has ult?
Output: who has ult?

Input: where are you going?
Output: where are you going?

Input: абрамс ушёл
Output: абрамс ушёл

Input: i am so bad today lol
Output: i am so bad today lol

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

Input: nigger kys
Output: nice try team we got this

Input: team noob zero damage
Output: good effort team lets reset`;

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
                    { role: 'user', content: text }
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
