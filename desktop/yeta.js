'use strict';

// Yeta: a gateway of its own at platform.yeta.ai, with credits on signing up. The API is the OpenAI Chat Completions
// one, so a request is little more than the chat as it is kept, with the system prompt's parts joined.
const API_URL = 'https://platform.yeta.ai/v1';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// Nothing here says what thinking levels a model takes, so the control offers the one level that says nothing.
const NONE = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };
// The list holds makers besides chat: embedders, rerankers and picture and speech makers are told apart by name.
const NOT_CHAT = /embed|rerank|moderation|whisper|tts|stt|speech|transcri|audio|image|video|diffusion|flux|sdxl|guard|ocr|realtime|translat/i;

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// What a refusal says. The gateway answers as the OpenAI API does; its own errors carry `message` under `error`.
async function failure(response) {
	let detail = '';
	try {
		const body = await response.json();
		detail = typeof body.error === 'string' ? body.error : body.error?.message || body.detail || body.message || '';
	} catch {}
	return error(detail || `Yeta returned error ${response.status}`, response.status);
}

// Two words from the service say a model costs nothing: its name ending in `:free`, and a price of nothing on both
// sides of it. A price left out is not a price of nothing — Number(null) is 0, and a gateway that publishes no price
// for a model must not be read as giving it away — so both sides are asked for by name before either is weighed.
function freeOf(model) {
	if (/:free$/i.test(String(model.id))) return true;
	const price = model.pricing || model.price || null;
	if (!price) return false;
	const prompt = price.prompt ?? price.prompt_price ?? price.input ?? null;
	const completion = price.completion ?? price.completion_price ?? price.output ?? null;
	return prompt != null && completion != null && Number(prompt) === 0 && Number(completion) === 0;
}

// The first of several words a gateway may use for one thing.
const said = (...values) => values.find(value => value !== undefined && value !== null) ?? null;

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, and one
// that turned down a picture is known not to see.
const noTools = new Set(), noPictures = new Set();

const titled = slug => slug.split(/[-_]/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
// Companies whose own name is not the capitalisation their id gives.
const COMPANIES = { openai: 'OpenAI', deepseek: 'DeepSeek', deepseekai: 'DeepSeek', moonshotai: 'Moonshot AI', moonshot: 'Moonshot AI', zai: 'Z.ai', 'z-ai': 'Z.ai', anthropic: 'Anthropic', google: 'Google', qwen: 'Qwen', alibaba: 'Alibaba', baidu: 'Baidu', xai: 'xAI', xingchen: 'Xingchen', internlm: 'InternLM' };
const authorOf = id => {
	const at = String(id).indexOf('/');
	return at < 1 ? '' : id.slice(0, at);
};
const shortName = id => {
	const at = String(id).indexOf('/');
	return at < 0 ? String(id) : id.slice(at + 1);
};
// The company under a name the gateway gives, spelled as the company spells itself.
const companyOf = name => COMPANIES[String(name).toLowerCase().replace(/\s+/g, '')] || titled(name);

// A display name of "DeepSeek: V4.1 Flash" reads better without its company in front, which the group shows anyway.
function shortNameOf(full) {
	const text = String(full), at = text.indexOf(': ');
	return at > 0 ? text.slice(at + 2).trim() : text;
}

function described(model) {
	const arch = model.architecture || {};
	const input = Array.isArray(model.input_modalities) ? model.input_modalities : Array.isArray(arch.input_modalities) ? arch.input_modalities : null;
	const params = Array.isArray(model.supported_parameters) ? model.supported_parameters : null;
	const shown = said(model.name, model.display_name);
	return {
		id: `yeta:${model.id}`,
		provider: 'yeta',
		api: model.id,
		// The word that a free variant carries in its name is said again by the badge, so the name goes without it.
		name: shown ? shortNameOf(shown) : shortName(model.id).replace(/:free$/i, ''),
		// The gateway's `owned_by` is a channel word, not a company — these gateways put "array" there — so only a
		// family it names for the model, or the author at the head of its id, says who made it.
		group: model.model_family ? companyOf(model.model_family) : companyOf(authorOf(model.id)),
		// What the list does not say is left unsaid rather than guessed at: a window of none means the app takes the
		// settings' own default, as it does for NVIDIA.
		context: Number(said(model.context_length, model.context_window, model.max_input_tokens)) || 0,
		output: Number(model.max_output_tokens) || 0,
		// A model is taken to see until it turns a picture down, which is remembered and asked without one: a wrong
		// guess costs a turn, where taking it as blind would shut pictures out for good.
		vision: (input ? input.some(kind => /image|vision/i.test(String(kind))) : true) && !noPictures.has(model.id),
		tools: (params ? params.includes('tools') : true) && !noTools.has(model.id),
		free: freeOf(model),
		...NONE,
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = api => described({ id: api });

// The models the key may chat with. The gateway answers its list only to a key it takes — a missing, empty or revoked
// token is turned away here with 401 — so reading the list is also the check of the key, and needs no second request.
// No word of the key's shape is said first: the service gives no sign of what format it issues, and a guess would
// turn away a working key, where the 401 below catches every wrong one anyway.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
	const hand = [...new Set(names)].filter(id => typeof id === 'string' && id).map(byHand);
	let response;
	try {
		response = await fetch(`${apiUrl}/models`, { headers: headers(key) });
	} catch {
		if (hand.length) return hand;
		throw error('network', 0, 'network');
	}
	if (!response.ok) {
		const problem = await failure(response);
		// A key the service does not take must be seen as that, even with models named by hand; any other failure
		// leaves them usable.
		if (hand.length && problem.status !== 401 && problem.status !== 403) return hand;
		throw problem;
	}
	const body = await response.json();
	const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
	if (!list) throw error('Yeta sent no list of models');
	const listed = list.filter(model => typeof model?.id === 'string' && model.id && !NOT_CHAT.test(model.id)).map(described);
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
	// Nothing is said of thinking: the list names no levels, and a word it does not take is not sent to it.
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
			if (event.error) throw error(event.error.message || 'Yeta stopped the answer', Number(event.error.code) || 0, String(event.error.code || ''));
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
		if (!ended && !result.finishReason) throw error('Yeta disconnected before completing the answer', 0, 'network');
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

module.exports = { models, stream, convert, build, described, freeOf, API_URL };
