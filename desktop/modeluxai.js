'use strict';

// ModelUXAI: an Indonesian gateway at api.modeluxai.com, one OpenAI-compatible door over models in the account's group
// (and an Anthropic-compatible one beside it, which this engine does not use). Its own documentation is the source of
// everything claimed here, and where the documentation and the live door differ, the door wins — the billing route the
// v1 docs name now answers 404, for instance.
//
// The list is not public: /v1/models answers 401 to no key, to a key through a query string (400), and to a wrong one
// alike, so reading the list is weighing the key — no token is spent and no model is asked anything.
//
// There is no per-model price to read. The list is `{object, data:[{id, object}]}`, one entry per model the account's
// group holds, and the portal's Free/Pro/Premium are account plans (Rp0 / Rp35.000 / Rp100.000), not model prices. So no
// model is marked free unless the list itself ever carries a zero price or a free flag; a plan is not a model.

const API_URL = 'https://api.modeluxai.com/v1';
const KEY_HINT = 'A ModelUXAI key is made in its dashboard at modeluxai.com';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// Nothing here says what thinking levels a model takes, so the control offers the one level that says nothing.
const NONE = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };
const NOT_CHAT = /embed|rerank|moderation|whisper|tts|stt|speech|transcri|audio|image|video|diffusion|flux|sdxl|(?<![a-z])guard|ocr|realtime|translat/i;
const PROBE_WAIT = 10000;

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// Two error shapes stand at this door, and both are read here: the gateway's own {code, message, reason} — which is what
// a key that is missing, wrong or inactive meets — and the OpenAI one {error: {type, message}} that the chat handler
// answers with. Cloudflare answers for the service when it blocks a request, and then there is no JSON at all.
async function failure(response) {
	const text = await response.text().catch(() => '');
	let detail = '', code = '';
	try {
		const body = JSON.parse(text);
		if (body?.error && typeof body.error === 'object') {
			detail = body.error.message || body.error.type || '';
			code = String(body.error.code || body.error.type || '');
		} else {
			detail = typeof body?.message === 'string' ? body.message : '';
			code = String(body?.code ?? body?.reason ?? '');
		}
	} catch {
		const title = /<title[^>]*>([^<]{3,120})</i.exec(text);
		detail = title ? title[1].trim() : '';
	}
	return error(detail || `ModelUXAI returned error ${response.status}`, response.status, code);
}

// A block from the protection in front is not the service turning a key down.
const blocked = (status, message) => status === 403 && /cloudflare|challenge|access denied|blocked|sorry/i.test(String(message));

// Free only on evidence: an explicit flag the list carries, or prices that are all zero. A model with no price is not a
// price of nothing, and an account's free plan says nothing about any one model.
function freeOf(model) {
	if (model?.free === true || model?.is_free === true || model?.free_tier === true) return true;
	const price = model?.pricing;
	if (!price || typeof price !== 'object') return false;
	const sides = ['input_per_m', 'output_per_m', 'cached_input_per_m', 'input', 'output', 'cached_input']
		.map(side => Number(price[side])).filter(Number.isFinite);
	return sides.length > 0 && sides.every(side => side === 0);
}

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, and one
// that turned down a picture is known not to see.
const noTools = new Set(), noPictures = new Set();

// The maker behind an id. The list names the gateway itself when it names anyone, so the head of the id is where the
// maker is read — the same names their family goes by.
const MAKERS = { glm: 'Z.ai', deepseek: 'DeepSeek', solar: 'Upstage', qwen: 'Qwen', claude: 'Anthropic', gpt: 'OpenAI',
	gemini: 'Google', kimi: 'Moonshot AI', minimax: 'MiniMax', llama: 'Meta', mistral: 'Mistral AI', grok: 'xAI', lfm: 'Liquid AI' };
function groupOf(model) {
	const owner = String(model?.owned_by || '').trim();
	if (owner && !/^modelux/i.test(owner)) return owner;
	const head = String(model?.id || '').split(/[-_.:/]/)[0].toLowerCase();
	return MAKERS[head] || '';
}

function described(model) {
	return {
		id: `modeluxai:${model.id}`,
		provider: 'modeluxai',
		api: model.id,
		// The id carries no vendor path in the list's own example; the name is the id as the account's group spells it.
		name: String(model.id),
		group: groupOf(model),
		// What the list says where it says anything; what it does not say is left unsaid rather than guessed at.
		context: Number(model.context_length || model.context_window) || 0,
		output: Number(model.max_output_tokens || model.max_completion_tokens) || 0,
		vision: model.vision !== false && !noPictures.has(model.id),
		tools: model.tools !== false && !noTools.has(model.id),
		free: freeOf(model),
		...NONE,
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = api => described({ id: api });

// The models the key may chat with, as the service lists them, then the ones the user named that it does not hold.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
	const secret = String(key || '').trim();
	// An empty field is never checked. A space pasted into the field is turned back here rather than sent as a key.
	if (!secret) throw error('ModelUXAI wants its key before any model can be read.', 400, 'key');
	const hand = [...new Set(names)].filter(id => typeof id === 'string' && id).map(byHand);
	let response;
	try {
		response = await fetch(`${apiUrl}/models`, { headers: headers(secret), signal: AbortSignal.timeout(PROBE_WAIT) });
	} catch {
		if (hand.length) return hand;
		throw error('network', 0, 'network');
	}
	if (!response.ok) {
		const problem = await failure(response);
		if (blocked(problem.status, problem.message)) throw error('ModelUXAI’s web protection refused this request. Try again in a little while.', 403);
		// A key the service does not take must be seen as that, even with models named by hand; any other failure
		// leaves them usable.
		if (hand.length && problem.status !== 401 && problem.status !== 403) return hand;
		throw problem;
	}
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body?.data)) throw error('ModelUXAI sent no list of models');
	const listed = body.data
		.filter(model => typeof model?.id === 'string' && model.id && !NOT_CHAT.test(model.id))
		.map(described);
	const have = new Set(listed.map(model => model.api));
	return [...listed, ...hand.filter(model => !have.has(model.api))];
}

const text = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');

function parts(content, vision) {
	if (!Array.isArray(content)) return content || '';
	return content.map(part => part.type !== 'image_url' ? { type: 'text', text: part.text || '' }
		: vision ? { type: 'image_url', image_url: { url: part.image_url.url } } : { type: 'text', text: NO_VISION });
}

function turn(message, vision) {
	if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content || '' };
	if (message.role !== 'assistant') return { role: message.role === 'system' ? 'system' : 'user', content: parts(message.content, vision) };
	const calls = (message.tool_calls || []).map(call => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments || '{}' } }));
	const out = { role: 'assistant', content: message.content || '' };
	if (calls.length) out.tool_calls = calls;
	return out;
}

// The system prompt's parts open the request as one message.
function convert(messages, { vision = false } = {}) {
	const lead = messages.findIndex(message => message.role !== 'system'), count = lead < 0 ? messages.length : lead;
	const system = messages.slice(0, count).map(message => text(message.content)).filter(Boolean), out = [];
	if (system.length) out.push({ role: 'system', content: system.join('\n\n') });
	for (const message of messages.slice(count)) out.push(turn(message, vision));
	return out;
}

const functions = tools => tools.map(tool => ({ type: 'function', function: { name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters } }));

function build(request, asked = { pictures: request.vision === true, tools: !!request.tools?.length, usage: true }) {
	const body = { model: request.model, messages: convert(request.messages, { vision: asked.pictures }), stream: true };
	// The tokens used come with the answer's last event by themselves, where the model takes the word for it.
	if (asked.usage) body.stream_options = { include_usage: true };
	const room = request.maxTokens ? (request.output ? Math.min(request.maxTokens, request.output) : request.maxTokens) : 0;
	if (room) body.max_tokens = room;
	if (asked.tools && request.tools?.length) body.tools = functions(request.tools);
	return body;
}

const STREAM_DONE = Symbol('stream done');
async function* events(body) {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop();
		for (const raw of lines) {
			// Lines that begin with a colon only keep the connection open.
			const line = raw.trimEnd();
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') { yield STREAM_DONE; return; }
			if (!data) continue;
			let event;
			try { event = JSON.parse(data); } catch { continue; }
			yield event;
		}
	}
	const line = buffer.trimEnd();
	if (line.startsWith('data:')) {
		const data = line.slice(5).trim();
		if (data === '[DONE]') yield STREAM_DONE;
		else if (data) {
			let event;
			try { event = JSON.parse(data); } catch {}
			if (event) yield event;
		}
	}
}

async function post(request, body, { signal, apiUrl = API_URL } = {}) {
	try {
		return await fetch(`${apiUrl}/chat/completions`, {
			method: 'POST', signal,
			headers: { ...headers(request.key), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
			body: JSON.stringify(body),
		});
	} catch (cause) {
		if (cause.name === 'AbortError') throw cause;
		throw error('network', 0, 'network');
	}
}

// A model that sees no picture, calls no tools or takes no usage word says so only when it is sent one: it is then
// asked again without it, and the list is read anew so the app knows too.
async function asking(request, send) {
	const model = request.model;
	const pictured = request.vision === true && request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
	const asked = { pictures: pictured && !noPictures.has(model), tools: !noTools.has(model) && !!request.tools?.length, usage: true };
	let stale = false;
	for (;;) {
		const response = await send(asked);
		if (response.ok) return { response, stale };
		const problem = await failure(response);
		if (blocked(problem.status, problem.message)) throw error('ModelUXAI’s web protection refused this request. Try again in a little while.', 403);
		const dropped = problem.status !== 400 ? '' : asked.tools && /tool|function/i.test(problem.message) ? 'tools'
			: asked.pictures && /image|vision|multimodal|multi-modal/i.test(problem.message) ? 'pictures'
			: asked.usage && /stream_options|include_usage/i.test(problem.message) ? 'usage' : '';
		if (!dropped) throw problem;
		asked[dropped] = false;
		if (dropped === 'tools') noTools.add(model);
		if (dropped === 'pictures') noPictures.add(model);
		stale = true;
	}
}

const FINISH = new Set(['stop', 'tool_calls', 'length', 'content_filter']);

function usageOf(usage) {
	return {
		prompt_tokens: usage.prompt_tokens || 0,
		completion_tokens: usage.completion_tokens || 0,
		total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
		cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
		written_tokens: 0,
	};
}

async function stream(request, { signal, onEvent = () => {}, apiUrl = API_URL } = {}) {
	const { response, stale } = await asking(request, asked => post(request, build(request, asked), { signal, apiUrl }));
	const calls = [], result = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
	let ended = false;
	try {
		for await (const event of events(response.body)) {
			if (event === STREAM_DONE) { ended = true; break; }
			// A model can fail mid-answer: the stream then carries the error instead of an HTTP status.
			if (event.error) throw error(event.error.message || 'ModelUXAI stopped the answer', Number(event.error.status) || 0, String(event.error.code || ''));
			if (event.usage) result.usage = usageOf(event.usage);
			const choice = event.choices?.[0];
			if (!choice) continue;
			const delta = choice.delta || {};
			// A reasoning model speaks its thinking apart from its answer.
			const thought = typeof delta.reasoning_content === 'string' && delta.reasoning_content ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
			if (thought) {
				result.reasoning += thought;
				onEvent({ type: 'reasoning', delta: thought });
			}
			if (typeof delta.content === 'string' && delta.content) {
				result.content += delta.content;
				onEvent({ type: 'content', delta: delta.content });
			}
			for (const part of delta.tool_calls || []) {
				onEvent({ type: 'activity' });
				// A piece says which call it belongs to by its index; one that doesn't belongs to the last call, unless it
				// brings a new id.
				const last = calls.length - 1, fresh = part.id && last >= 0 && calls[last].id && calls[last].id !== part.id;
				const call = calls[part.index ?? (fresh ? last + 1 : Math.max(0, last))] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
				if (part.id) call.id = part.id;
				if (part.function?.name) call.function.name += part.function.name;
				if (part.function?.arguments) call.function.arguments += part.function.arguments;
			}
			if (choice.finish_reason) result.finishReason = choice.finish_reason;
		}
		if (!ended && !result.finishReason) throw error('ModelUXAI disconnected before completing the answer', 0, 'network');
	} catch (cause) {
		if (cause.name === 'AbortError' || cause.status !== undefined) throw cause;
		if (!result.finishReason) throw error('network', 0, 'network');
	}
	result.toolCalls = calls.filter(call => call?.function.name);
	// A tool call cut off at the length limit is never run.
	if (result.finishReason === 'length') result.toolCalls = [];
	if (!FINISH.has(result.finishReason)) result.finishReason = result.toolCalls.length ? 'tool_calls' : 'stop';
	if (stale) result.stale = true;
	return result;
}

module.exports = { models, stream, convert, build, described, freeOf, groupOf, API_URL, KEY_HINT };
