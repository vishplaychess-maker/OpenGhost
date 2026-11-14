'use strict';

// NaraRouter: an Indonesian AI gateway at router.bynara.id — one OpenAI-compatible door (and an Anthropic one) over
// many companies' models, priced in credits where one credit is one Rupiah. A free plan gives a daily token quota,
// and that quota is kept per model class, not as one account-wide pool: when one class runs out, only that class is
// answered 429 while the others keep working.
//
// The key is what opens the list. /v1/models answers 401 to no key, an empty one and a wrong one alike — measured, not
// assumed — so reading the list is also weighing the key, and no separate probe endpoint is needed. Keys begin with
// the prefix the documentation states, `sk-nry-`, so a field holding something else is turned back before anything is
// sent rather than after a round trip that could only say the same thing.
//
// What is free is said by the gateway's own pricing catalog, not guessed at. That catalog is public and lists every
// alias with the credits it takes per thousand tokens; a model costs nothing only when both sides are zero, which
// today is three of fifty-one aliases. A model the catalog does not carry goes unmarked: a price that is not there is
// not a price of nothing, and a badge that lies about cost would make the free-only list a place to be disappointed.

const API_URL = 'https://router.bynara.id/v1';
const PRICING_URL = 'https://router.bynara.id/api/pricing';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// Nothing in the documentation says how to ask a model to think more or less, so the control offers the one level
// that says nothing rather than a knob that may be wired to nothing.
const NONE = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };
// The prefix the service documents. Only the prefix: what follows it is the service's business.
const KEY_SHAPE = /^sk-nry-/;
const KEY_HINT = 'A NaraRouter key begins with sk-nry- — make one at router.bynara.id/keys';
// Rows that are not chats. The catalog carries image and video models beside the chat ones.
const NOT_CHAT = /embed|rerank|moderation|whisper|tts|stt|speech|transcri|image|video|diffusion|flux|sdxl|guard|ocr|realtime|translat/i;

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// What a refusal says. The door answers as the OpenAI API does and carries a type and a request id; the id is worth
// keeping because the service asks for it when a call needs explaining.
async function failure(response) {
	const text = await response.text().catch(() => '');
	let detail = '', code = '';
	try {
		const body = JSON.parse(text);
		const given = body.error || body;
		detail = typeof given === 'string' ? given : given.message || body.detail || body.message || '';
		code = String(given.code || given.type || body.code || '');
	} catch {
		const title = /<title[^>]*>([^<]{3,120})</i.exec(text);
		detail = title ? title[1].trim() : '';
	}
	const id = /"request_id":"([^"]{1,40})"/.exec(text);
	return error(detail ? `${detail}${id ? ` (request ${id[1]})` : ''}` : `NaraRouter returned error ${response.status}`, response.status, code.toLowerCase());
}

// The public catalog, read at most once every few minutes: it is the only place the credit rates are written down.
const CATALOG = { ms: 5 * 60 * 1000 };
let catalog = { at: 0, by: new Map() };

async function pricing() {
	if (catalog.at && Date.now() - catalog.at < CATALOG.ms) return catalog.by;
	let by = catalog.by;
	try {
		const response = await fetch(PRICING_URL, { signal: AbortSignal.timeout(10000) });
		if (response.ok) {
			const body = await response.json().catch(() => null);
			const rows = Array.isArray(body?.data) ? body.data : [];
			by = new Map(rows.filter(row => typeof row?.alias === 'string').map(row => [row.alias.toLowerCase(), row]));
		}
	} catch {
		// A catalog that cannot be reached leaves the rates unknown, which is said by leaving models unmarked.
	}
	catalog = { at: Date.now(), by };
	return by;
}

// Zero on both sides is the only word that a model costs nothing. One side of two being zero is a discount, not free.
function freeOf(alias, model, by) {
	const row = by.get(String(alias || '').toLowerCase()) || null;
	if (row) {
		const input = row.input_credit_per_1k ?? row.input_price ?? null;
		const output = row.output_credit_per_1k ?? row.output_price ?? null;
		if (input != null && output != null) return Number(input) === 0 && Number(output) === 0;
	}
	// A list that carries its own prices is read too, for the day the two sources disagree or the catalog moves.
	const price = model.pricing || model.price || null;
	if (!price) return false;
	const input = price.prompt ?? price.input ?? price.input_credit_per_1k ?? null;
	const output = price.completion ?? price.output ?? price.output_credit_per_1k ?? null;
	return input != null && output != null && Number(input) === 0 && Number(output) === 0;
}

// The makers behind the aliases. Their names come from the id when the list does not say one, so a model is filed
// under the company whose model it is rather than under the gateway.
const COMPANIES = { claude: 'Anthropic', gpt: 'OpenAI', o: 'OpenAI', gemini: 'Google', grok: 'xAI', kimi: 'Moonshot AI', deepseek: 'DeepSeek', qwen: 'Qwen', glm: 'Zhipu', doubao: 'ByteDance', minimax: 'MiniMax', mistral: 'Mistral AI', llama: 'Meta', lfm: 'Liquid AI', magistral: 'Mistral AI', hunyuan: 'Tencent', ernie: 'Baidu', step: 'StepFun', nova: 'Amazon', command: 'Cohere', phi: 'Microsoft', groq: 'Groq', flash: 'NaraRouter' };
const first = id => String(id || '').split(/[-.:]/)[0].toLowerCase();
const groupOf = model => COMPANIES[first(model.id)] || '';

function described(model, by) {
	const row = by.get(String(model.id).toLowerCase()) || by.get(String(model.id).split(':')[0].toLowerCase()) || null;
	const name = model.display_name || model.name || (row && row.display_name) || model.id;
	return {
		id: `nararouter:${model.id}`,
		provider: 'nararouter',
		api: model.id,
		// The word that a model costs nothing stands by it in the badge, so the name goes without it.
		name: String(name).replace(/\s*\(:?free\)\s*$/i, ''),
		group: groupOf(model),
		context: Number(model.context_length || model.max_input_tokens || (row && row.max_context_tokens)) || 0,
		output: Number(model.max_completion_tokens || model.max_tokens) || 0,
		// The catalog says plainly whether a model takes pictures; a list that says nothing is taken at its word.
		vision: row ? row.supports_vision !== false : model.supports_vision !== false,
		tools: model.supports_tools !== false && row?.payg_enabled !== undefined ? true : model.tools !== false,
		free: freeOf(model.id, model, by),
		...NONE,
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = (api, by) => described({ id: api }, by);

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, and one
// that turned down a picture is known not to see.
const noTools = new Set(), noPictures = new Set();

// The models this key may chat with, as the service lists them, then the ones the user named that it does not hold.
async function models({ key, names = [] }, { apiUrl = API_URL, pricingUrl = PRICING_URL } = {}) {
	const secret = String(key || '').trim();
	// An empty field is never sent. A field that holds something else is turned back here, because the shape is
	// documented and a round trip would only say the same thing later.
	if (!secret) throw error('NaraRouter wants its key before any model can be read.', 400, 'key');
	if (!KEY_SHAPE.test(secret)) throw error(KEY_HINT, 400, 'key');
	const hand = [...new Set(names)].filter(id => typeof id === 'string' && id);
	let response;
	try {
		response = await fetch(`${apiUrl}/models`, { headers: headers(secret) });
	} catch {
		if (hand.length) { const by = await pricing(); return hand.map(id => byHand(id, by)); }
		throw error('network', 0, 'network');
	}
	if (!response.ok) {
		const problem = await failure(response);
		// A key the service does not take must be seen as that, even with models named by hand; any other failure
		// leaves them usable.
		if (hand.length && problem.status !== 401 && problem.status !== 403) { const by = await pricing(); return hand.map(id => byHand(id, by)); }
		throw problem;
	}
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body?.data)) throw error('NaraRouter sent no list of models');
	const by = await pricing();
	const listed = body.data
		.filter(model => typeof model?.id === 'string' && model.id && !NOT_CHAT.test(model.id))
		.map(model => described(model, by));
	const have = new Set(listed.map(model => model.api));
	return [...listed, ...hand.filter(id => !have.has(id)).map(id => byHand(id, by))];
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
			if (event.error) throw error(event.error.message || 'NaraRouter stopped the answer', Number(event.error.status) || 0, String(event.error.code || event.error.type || '').toLowerCase());
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
		if (!ended && !result.finishReason) throw error('NaraRouter disconnected before completing the answer', 0, 'network');
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

module.exports = { supports_temperature: true, models, stream, convert, build, described, freeOf, pricing, KEY_SHAPE, KEY_HINT, API_URL, PRICING_URL };
