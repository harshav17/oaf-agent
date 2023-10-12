import OpenAI, { ClientOptions } from "openai";
import { IncomingMessage } from "http";
import { Writable } from "node:stream";
import debugModule from "debug";
import { ChatCompletionMessageParam, Chat, ChatCompletionCreateParams } from "openai/resources/chat";

const decoder = new TextDecoder("utf-8");
const debug = debugModule("oaf:core");

const DEFAULT_MODEL = "gpt-4-0613";
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TEMPERATURE = 0.5;

export type OafOptions = {
    finString: string;
    funcs?: any;
    funcDescs?: ChatCompletionCreateParams.Function[];
    model?: string;
    max_tokens?: number;
    tempature?: number;
    shouldRecurse?: boolean;
};
export async function callOaf(messages: ChatCompletionMessageParam[], clientOpts: ClientOptions, options: OafOptions) {
    const openai = new OpenAI(clientOpts);
    debug("Started oaf with messages: %o", messages);

	let { readable, writable } = new TransformStream();
	let writer = writable.getWriter();
    
    callOafHelper(messages, writer, openai, options);

    return new Response(readable);
}

async function callOafHelper(messages: ChatCompletionMessageParam[], writer: WritableStreamDefaultWriter<any>, openai: OpenAI, options: OafOptions, isRecursive: boolean = false) {
    const { finString, model, max_tokens, tempature, funcDescs, funcs, shouldRecurse } = options;
    let functionCalls: any[] = [];
    let currentFunctionCallName = "";
    let currentMessageFromGPT = "";
    debug("Started oaf with funcs: %o", funcDescs);
    try {
        const stream = await openai.chat.completions.create({
            model:  model || DEFAULT_MODEL,
            messages: messages,
            stream: true,
            functions: funcDescs ? funcDescs : undefined,
            function_call: funcDescs ? "auto" : undefined,
            temperature: tempature || DEFAULT_TEMPERATURE,
            max_tokens: max_tokens || DEFAULT_MAX_TOKENS,
        });

        for await (const part of stream) {
            const { finish_reason } = part.choices[0];
            const { content, function_call } = part.choices[0].delta;
            if (finish_reason) {
                break;
            } else if (content) {
                currentMessageFromGPT += content;
                writer.write(content);
            } else if (function_call) {
                if (function_call.name) {
                    writer.write(function_call.name);
                    currentFunctionCallName = function_call.name;
                }
                if (function_call.arguments) {
                    writer.write(function_call.arguments);
                    let existingFunctionCall = functionCalls.find((call) => call.name === currentFunctionCallName);
                    if (existingFunctionCall) {
                        // If a function call with the same name already exists, append the args
                        existingFunctionCall.argsString += function_call.arguments;
                    } else {
                        // Otherwise, create a new function call
                        functionCalls.push({
                            name: currentFunctionCallName,
                            argsString: function_call.arguments || {},
                        });
                    }
                }
            }    
        }

        if (currentMessageFromGPT.trim().length > 0) {
            messages.push({
                role: "assistant",
                content: currentMessageFromGPT,
            });
        }

        for (let functionCall of functionCalls) {
            const func = (funcs as any)[String(functionCall.name)];
            if (func) {
                debug("Calling function %s with args %o", functionCall.name, functionCall.argsString);
                const args = JSON.parse(functionCall.argsString.replace(/\r?\n|\r/g, ''));
                const funcRes = await func(args);

                messages.push({
                    role: "assistant",
                    content: "",
                    function_call: {
                        name: functionCall.name,
                        arguments: JSON.stringify(args),
                    },
                });
                messages.push({
                    role: "function",
                    content: JSON.stringify(funcRes),
                    name: functionCall.name,
                });
            }
        }

        if (!shouldRecurse || currentMessageFromGPT.includes(finString)) {
            debug("currentMessageFromGPT: %s", currentMessageFromGPT)
            debug("LOC 2. Finished. Returning true.")
            writer.close();
        } else {
            // otherwise, continue recursing
            debug("currentMessageFromGPT: %s", currentMessageFromGPT)
            debug("Not finished yet. Recursively calling oaf with messages: %o", messages)
            const isFinished = await callOafHelper(messages, writer, openai, options, true);
            if (isFinished) {
                if (!isRecursive) {
                    debug("LOC 3. Finished. Returning true.")
                    writer.close();
                }
                return true;
            }
        }
    } catch (e) {
        debug("Error: %o", e);
        writer.write("Error: " + e);
        writer.close();
    }
}