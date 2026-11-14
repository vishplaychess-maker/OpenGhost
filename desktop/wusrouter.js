'use strict';

// WusRouter: a community gateway of many companies' models at api.wusrouter.com, with a key made at wusrouter.com.
// The API is the OpenAI Chat Completions one, so a request is little more than the chat as it is kept, with the system
// prompt's parts joined.
// Read the note in settings before using it: who runs this service is not stated anywhere on its own page, it keeps no
// word on retention, and it sells models whose safety filters have been taken off. Everything a chat holds — the
// conversation, what the agent reads off this computer, any picture attached — goes to it.
const API_URL = 'https://api.wusrouter.com/v1';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// Nothing here says what thinking levels a model takes, so the control offers the one level that says nothing.
const NONE = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };
// The list holds makers besides chat, and says nothing but their names, so a name is all there is to tell them by.
const NOT_CHAT = /embed|rerank|moderation|whisper|tts|stt|speech|transcri|audio|image|video|diffusion|flux|sdxl|guard|ocr|realtime|translat/i;
// The gateway's list is public: it answers 200 with no key, an empty one, or a wrong one. So the list says nothing
// about a key. A request is what tells: a key it does not take is answered 401, and a request that carries no key at
// all — an empty one, or a space pasted into the field — is answered 404. Both mean the same thing here.
const PROBE_WAIT = 8000;

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// What a refusal says. The gateway answers as the OpenAI API does; Cloudflare answers for it when it blocks a request,
// and then there is no JSON at all — only a page, which must not be shown to a person as if it were the service's word.
async function failure(response) {
	const text = await response.text().catch(() => '');
	let detail = '';
	try {
		const body = JSON.parse(text);
		detail = typeof body.error === 'string' ? body.error : body.error?.message || body.detail || body.message || '';
	} catch {
		// Not JSON: a wall of HTML from the protection in front, whose title is the only readable part of it.
		const title = /<title[^>]*>([^<]{3,120})</i.exec(text);
		detail = title ? title[1].trim() : '';
	}
	return error(detail || `WusRouter returned error ${response.status}`, response.status);
}

// A block from the protection in front is not the service turning a key down, and must not be said as that: it is
// Cloudflare refusing the request, which clears by itself.
const blocked = (status, message) => status === 403 && /cloudflare|challenge|access denied|blocked|sorry/i.test(String(message));

// WusRouter says a free model is one whose name ends in `:free`; its list carries no prices at all, so the price words
// below are there for the day it starts saying them. A price left out is not a price of nothing.
function freeOf(model) {
	if (/:free$/i.test(String(model.id))) return true;
	const price = model.pricing || model.price || null;
	if (!price) return false;
	const prompt = price.prompt ?? price.prompt_price ?? price.input ?? null;
	const completion = price.completion ?? price.completion_price ?? price.output ?? null;
	return prompt != null && completion != null && Number(prompt) === 0 && Number(completion) === 0;
}

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, and one
// that turned down a picture is known not to see.
const noTools = new Set(), noPictures = new Set();

const COMPANIES = { deepseek: 'DeepSeek', openai: 'OpenAI', gemini: 'Google', google: 'Google', qwen: 'Qwen', zhipu: 'Zhipu', glm: 'Zhipu', minimax: 'MiniMax', anthropic: 'Anthropic', moonshot: 'Moonshot AI', mistral: 'Mistral AI', cohere: 'Cohere' };
// The pools the gateway names at the head of an id.
const POOLS = { wusrouter: 'WusRouter', wr: 'WusRouter', uc: 'WusRouter', tn: 'WusRouter', jailbreak: 'Filters off', uncensored: 'Filters off' };
// Variants sold with the maker's safety filters taken off. Nearly two in five of this list is one, some written at the
// head of the id and some at its end, and the ones written at the end would otherwise be filed under the maker whose
// model they route to — as if that maker shipped them.
const OFF = /jailbreak|uncensored|abliterated|no[-_]?filter|dark[-_]?mode/i;
const titled = slug => slug.split(/[-_]/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

// The company a model is shown under, with the filter-off variants set apart from the makers they borrow a name from.
function groupOf(model) {
	const id = String(model.id);
	if (OFF.test(id)) return 'Filters off';
	const at = id.indexOf('/');
	if (at > 0) { const head = id.slice(0, at).toLowerCase(); return POOLS[head] || titled(head); }
	return COMPANIES[String(model.owned_by || '').toLowerCase()] || '';
}

function described(model) {
	return {
		id: `wusrouter:${model.id}`,
		provider: 'wusrouter',
		api: model.id,
		// The word that a variant is free is said by the badge, so the name goes without it.
		name: model.id.slice(String(model.id).indexOf('/') + 1).replace(/:free$/i, ''),
		group: groupOf(model),
		// The list says only a name. What it does not say is left unsaid rather than guessed at.
		context: Number(model.context_window || model.context_length) || 0,
		output: Number(model.max_output_tokens) || 0,
		vision: !noPictures.has(model.id),
		tools: !noTools.has(model.id),
		free: freeOf(model),
		...NONE,
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = api => described({ id: api });

// The key's standing, which the public list cannot tell. The gateway weighs the key before the body, so a request
// carrying one it does not take is answered 401, and one carrying nothing to weigh is answered 404 — both mean the
// same thing, and neither is a request that got through. Asking with a name the list itself just gave, and no
// messages, means nothing is ever generated to be paid for.
const verified = new Set();

async function takes(key, model, { apiUrl = API_URL } = {}) {
	if (verified.has(key)) return;
	let response, body;
	try {
		response = await fetch(`${apiUrl}/chat/completions`, {
			method: 'POST', signal: AbortSignal.timeout(PROBE_WAIT),
			headers: { ...headers(key), 'Content-Type': 'application/json' },
			body: JSON.stringify({ model, messages: [], max_tokens: 1 }),
		});
		body = await response.text().catch(() => '');
	} catch {
		// Nothing is said of a key whose server could not be reached: the list's own answer stands.
		return;
	}
	if (blocked(response.status, body)) throw error('WusRouter’s web protection refused this request. Try again in a little while.', 403);
	if (response.status === 401 || response.status === 404) throw error('WusRouter did not take this key', 401);
	if (response.status === 429 || response.status >= 500) return;
	verified.add(key);
}

// The models the key may chat with, as the gateway lists them, then the ones the user named that it does not hold.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
	const secret = String(key || '').trim();
	// An empty field is never checked, but a space pasted into one is — and this gateway answers that as no key at all.
	if (!secret) throw error('WusRouter wants its key before any model can be read.', 400, 'key');
	const hand = [...new Set(names)].filter(id => typeof id === 'string' && id).map(byHand);
	let response;
	try {
		response = await fetch(`${apiUrl}/models`, { headers: headers(secret) });
	} catch {
		if (hand.length) return hand;
		throw error('network', 0, 'network');
	}
	if (!response.ok) {
		const problem = await failure(response);
		if (blocked(problem.status, problem.message)) throw error('WusRouter’s web protection refused this request. Try again in a little while.', 403);
		// A key the service does not take must be seen as that, even with models named by hand; any other failure
		// leaves them usable.
		if (hand.length && problem.status !== 401 && problem.status !== 403) return hand;
		throw problem;
	}
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body?.data)) throw error('WusRouter sent no list of models');
	// The list comes first because it is public; one of the names it gives is then what the key is weighed with.
	const named = body.data.find(model => typeof model?.id === 'string' && model.id);
	if (named) await takes(secret, named.id, { apiUrl });
	const listed = body.data.filter(model => typeof model?.id === 'string' && model.id && !NOT_CHAT.test(model.id)).map(described);
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
		if (blocked(problem.status, problem.message)) throw error('WusRouter’s web protection refused this request. Try again in a little while.', 403);
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
			if (event.error) throw error(event.error.message || 'WusRouter stopped the answer', Number(event.error.code) || 0, String(event.error.code || ''));
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
		if (!ended && !result.finishReason) throw error('WusRouter disconnected before completing the answer', 0, 'network');
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

module.exports = { supports_temperature: true, models, stream, convert, build, described, freeOf, API_URL };
