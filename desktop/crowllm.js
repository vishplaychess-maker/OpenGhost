'use strict';

// CrowLLM: a reseller gateway at crowllm.com — one OpenAI-compatible key over the models of twenty makers, with a
// free shelf. Its /v1/models answers anyone, with no key, an empty one or a wrong one alike, so the list says nothing
// about a key. A request does: the door weighs the token before it reads the body, so a key it does not take is
// answered 401 even for a model that does not exist — which is how this engine weighs one without generating a token
// of anything. There is no balance or usage endpoint to read instead (every one tried answers 404).
// Free is said twice over: the id carries :free, and the public catalogue at /api/pricing prices the same models at
// zero. A model with no price in that catalogue is not a price of nothing, so it stays priced.
// What the service does not say is left unsaid rather than guessed at: the list names no window and no thinking level,
// so no window is claimed and the effort control offers only the level that says nothing.

const API_URL = 'https://crowllm.com/v1';
const CATALOGUE_URL = 'https://crowllm.com/api/pricing';
const KEY_HINT = 'A CrowLLM key begins with sk-crow- — make one at crowllm.com';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// A level that asks for nothing is the only one the service's own words support.
const NONE = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };
// Rows that are not chats. The list holds chat models today; this keeps an embedding or a speech row out of the picker
// the day it starts carrying one. `guard` is read at a word's own start, so OpenAI's gpt-oss-safeguard — a chat model
// with that word inside its name — stays in the picker while a guardrail classifier does not.
const NOT_CHAT = /embed|rerank|moderation|whisper|tts|stt|speech|transcri|audio|image|video|diffusion|flux|sdxl|(?<![a-z])guard|ocr|realtime|translat/i;
// Two waits: one for the weighing, one for the catalogue, which is a hundred kilobytes and only ever a bonus.
const PROBE_WAIT = 8000;
const CATALOGUE_WAIT = 8000;

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// What a refusal says. The door answers as the OpenAI API does — "Invalid token (request id: …)" is its word for a key
// it does not take, and the request id is the provider's bookkeeping, not something to show a person. Cloudflare
// answers for the service when it blocks a request, and then there is no JSON at all: only a page, whose title is the
// one readable part.
async function failure(response) {
	const text = await response.text().catch(() => '');
	let detail = '', code = '';
	try {
		const body = JSON.parse(text);
		detail = typeof body.error === 'string' ? body.error : body.error?.message || body.detail || body.message || '';
		code = String(body.error?.code || body.code || '');
	} catch {
		const title = /<title[^>]*>([^<]{3,120})</i.exec(text);
		detail = title ? title[1].trim() : '';
	}
	detail = detail.replace(/\s*\(request id:[^)]*\)/i, '').trim();
	return error(detail || `CrowLLM returned error ${response.status}`, response.status, code);
}

// A block from the protection in front is not the service turning a key down, and must not be said as that: it is
// Cloudflare refusing the request, which clears by itself.
const blocked = (status, message) => status === 403 && /cloudflare|challenge|access denied|blocked|sorry/i.test(String(message));

// A model is free when its id says so, or when the catalogue prices both sides at zero. A model the catalogue does not
// list is unmarked rather than guessed free.
function freeOf(model, catalogue = null) {
	if (/:free$/i.test(String(model.id))) return true;
	return !!catalogue?.get(String(model.id));
}

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, and one
// that turned down a picture is known not to see.
const noTools = new Set(), noPictures = new Set();

// The makers the list names in owned_by, as they write themselves. `custom` is what the gateway writes where it did not
// say, and is left out of the company row rather than shown as a company called "custom".
const COMPANIES = {
	'agnes ai': 'Agnes AI', alibaba: 'Alibaba', anthropic: 'Anthropic', baidu: 'Baidu', crow: 'Crow', deepseek: 'DeepSeek',
	google: 'Google', iflytek: 'iFlytek', meta: 'Meta', minimax: 'MiniMax', mistral: 'Mistral AI', moonshot: 'Moonshot AI',
	nvidia: 'NVIDIA', openai: 'OpenAI', tencent: 'Tencent', upstage: 'Upstage', xai: 'xAI', xiaomi: 'Xiaomi', zhipu: 'Zhipu',
};
// The vendors that sign their models at the head of the id. Only these are read as a company there: `caw/…` is Zhipu's
// model sold through the gateway's own pool, not a maker of its own.
const POOLS = { nvidia: 'NVIDIA', liquid: 'Liquid AI', openbmb: 'OpenBMB', runpod: 'RunPod' };
const titled = slug => slug.split(/[-_]/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

// The company a model is shown under: the vendor that signs its id when that is a known one, else the maker the list
// names — and if neither says, nothing rather than an invented name.
function groupOf(model) {
	const id = String(model.id), at = id.indexOf('/');
	if (at > 0) {
		const head = id.slice(0, at).toLowerCase();
		if (POOLS[head]) return POOLS[head];
	}
	return COMPANIES[String(model.owned_by || '').toLowerCase()] || '';
}

// The id without the vendor and the free mark, which the company row and the badge beside the name already say.
function nameOf(model) {
	const id = String(model.id);
	return id.slice(id.indexOf('/') + 1).replace(/:free$/i, '');
}

function described(model, catalogue = null) {
	return {
		id: `crowllm:${model.id}`,
		provider: 'crowllm',
		api: model.id,
		name: nameOf(model),
		group: groupOf(model),
		// The list says only a name. What it does not say is left unsaid rather than guessed at.
		context: Number(model.context_window || model.context_length) || 0,
		output: 0,
		vision: !noPictures.has(model.id),
		tools: !noTools.has(model.id),
		free: freeOf(model, catalogue),
		...NONE,
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = api => described({ id: api });

// The public catalogue, as a set of the models it prices at zero. Its absence costs only the price half of the free
// mark — the :free suffix still stands — so a catalogue that will not load is not a reason to fail the list.
async function catalogueOf(url = CATALOGUE_URL) {
	let response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(CATALOGUE_WAIT) });
	} catch {
		return null;
	}
	if (!response.ok) return null;
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body?.data)) return null;
	const free = new Map();
	for (const entry of body.data) {
		if (typeof entry?.model_name !== 'string' || !entry.model_name) continue;
		const zero = Number(entry.quota_type) === 0 && Number(entry.model_ratio) === 0 && Number(entry.model_price) === 0;
		free.set(entry.model_name, zero);
	}
	return free;
}

// The key's standing, which the public list cannot tell. The door checks the token before the model, so a name no
// model has is answered 401 for a key it does not take and something else entirely for one it does — a weighing that
// generates nothing. A door that is busy or unreachable says nothing of the key either way.
const verified = new Set();

async function takes(key, { apiUrl = API_URL } = {}) {
	if (verified.has(key)) return;
	let response, text;
	try {
		response = await fetch(`${apiUrl}/chat/completions`, {
			method: 'POST', signal: AbortSignal.timeout(PROBE_WAIT),
			headers: { ...headers(key), 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: '__openghost_key_probe__', messages: [{ role: 'user', content: 'key check' }], max_tokens: 1 }),
		});
		text = await response.text().catch(() => '');
	} catch {
		return;
	}
	if (blocked(response.status, text)) throw error('CrowLLM’s web protection refused this request. Try again in a little while.', 403);
	if (response.status === 401 || response.status === 403) {
		// The service's own word for it ("Invalid token"), which is what a person should read; the hint says where keys
		// are made when the door gave nothing readable at all.
		let detail = '';
		try { detail = JSON.parse(text)?.error?.message || ''; } catch {}
		throw error(String(detail).replace(/\s*\(request id:[^)]*\)/i, '').trim() || KEY_HINT, 401);
	}
	if (response.status === 429 || response.status >= 500) return;
	verified.add(key);
}

// The models the key may chat with, as the service lists them, then the ones the user named that it does not hold.
async function models({ key, names = [] }, { apiUrl = API_URL, catalogueUrl = CATALOGUE_URL } = {}) {
	const secret = String(key || '').trim();
	// An empty field is never checked: the list is public, but a picker with no key would only offer models that cannot
	// be called. A space pasted into the field is turned back here rather than sent as a key of its own.
	if (!secret) throw error('CrowLLM wants its key before any model can be read.', 400, 'key');
	const hand = [...new Set(names)].filter(id => typeof id === 'string' && id).map(byHand);
	const [response, catalogue] = await Promise.all([
		fetch(`${apiUrl}/models`).catch(() => null),
		catalogueOf(catalogueUrl),
	]);
	if (!response) {
		if (hand.length) return hand;
		throw error('network', 0, 'network');
	}
	if (!response.ok) {
		const problem = await failure(response);
		if (blocked(problem.status, problem.message)) throw error('CrowLLM’s web protection refused this request. Try again in a little while.', 403);
		// A key the service does not take must be seen as that, even with models named by hand; any other failure
		// leaves them usable.
		if (hand.length && problem.status !== 401 && problem.status !== 403) return hand;
		throw problem;
	}
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body?.data)) throw error('CrowLLM sent no list of models');
	// The list came for anyone; it is the request after it that says whether the key is one.
	await takes(secret, { apiUrl });
	const listed = body.data
		.filter(model => typeof model?.id === 'string' && model.id && !NOT_CHAT.test(model.id))
		.map(model => described(model, catalogue));
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
	// A temperature is only sent when the model is not thinking: reasoning models reject it, and a profile's temperature
	// is a wish about a plain answer, not about a thought.
	if (typeof request.temperature === 'number' && (!request.effort || request.effort === 'none')) body.temperature = request.temperature;
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

// A model that sees no picture, or calls no tools, says so only when it is sent some: it is then asked again without
// them, and the list of models is read anew so the app knows it too.
async function asking(request, send) {
	const model = request.model;
	const pictured = request.vision === true && request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
	const asked = { pictures: pictured && !noPictures.has(model), tools: !noTools.has(model) && !!request.tools?.length, usage: true };
	let stale = false;
	for (;;) {
		const response = await send(asked);
		if (response.ok) return { response, stale };
		const problem = await failure(response);
		if (blocked(problem.status, problem.message)) throw error('CrowLLM’s web protection refused this request. Try again in a little while.', 403);
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
			if (event.error) throw error(event.error.message || 'CrowLLM stopped the answer', Number(event.error.status) || 0, String(event.error.code || ''));
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
		if (!ended && !result.finishReason) throw error('CrowLLM disconnected before completing the answer', 0, 'network');
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

module.exports = { supports_temperature: true, models, stream, convert, build, described, freeOf, groupOf, catalogueOf, API_URL, CATALOGUE_URL, KEY_HINT };
