import { ChatCompletionRequestMessageRoleEnum, ChatCompletionRequestMessage, Configuration, OpenAIApi, ChatCompletionFunctions } from "openai";
import { IncomingMessage } from "http";
import { Writable } from "node:stream";
import debugModule from "debug";

const decoder = new TextDecoder("utf-8");
const debug = debugModule("oaf:core");

const DEFAULT_MODEL = "gpt-4-0613";
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TEMPERATURE = 0.5;

export type OafOptions = {
    finString: string;
    funcs?: any;
    funcDescs?: ChatCompletionFunctions[];
    model?: string;
    max_tokens?: number;
    tempature?: number;
    shouldRecurse?: boolean;
};
export async function callOaf(messages: ChatCompletionRequestMessage[], res: Writable, configuration: Configuration, options: OafOptions) {
    const openai = new OpenAIApi(configuration);
    debug("Started oaf with messages: %o", messages);
    await callOafHelper(messages, res, openai, options);
}

async function callOafHelper(messages: ChatCompletionRequestMessage[], res: Writable, openai: OpenAIApi, options: OafOptions, isRecursive: boolean = false, ) {
    const { finString, model, max_tokens, tempature, funcDescs, funcs, shouldRecurse } = options;
    let functionCalls: any[] = [];
    let currentFunctionCallName = "";
    let currentMessageFromGPT = "";
    debug("Started oaf with funcs: %o", funcDescs);
    try {
        const completion = await openai.createChatCompletion(
            {
                model: model || DEFAULT_MODEL, // TODO: Make this configurable
                messages: messages,
                stream: true,
                max_tokens: max_tokens || DEFAULT_MAX_TOKENS,
                temperature: tempature || DEFAULT_TEMPERATURE,
                functions: funcDescs ? funcDescs : undefined,
                function_call: funcDescs ? "auto" : undefined,
            },
            { responseType: "stream" },
        );

        const stream = completion.data as unknown as IncomingMessage;

        let partialLine = "";
        for await (const chunk of stream) {
            const value = decoder.decode(chunk);
            const lines = value.split("\n");
            lines[0] = partialLine + lines[0]; // prepend the leftover from the last chunk to the first line
            partialLine = lines.pop() || ""; // save the last line as it may be incomplete

            const parsedLines: any = lines
                .map((line) => line.replace("data: ", "")) // Remove the "data: " prefix
                .filter((line) => line !== "" && line !== "[DONE]") // Remove empty lines and "[DONE]"
                .map((line) => {
                    try {
                        return JSON.parse(line);
                    } catch(e) {
                        debug("Error parsing line: %s", line);
                        debug("Error details: %o", e);
                        return null;
                    }
                })
                .filter(line => line !== null); // Remove null lines

            for (const parsedLine of parsedLines) {
                const { error, choices } = parsedLine;
                if (error) {
                    // TODO send error back to client
                    res.end();
                    break;
                }
                const { content, function_call, finish_reason } = choices[0].delta;
                if (finish_reason) {
                    break;
                } else if (content) {
                    currentMessageFromGPT += content;
                    res.write(content);
                } else if (function_call) {
                    if (function_call.name) {
                        res.write(function_call.name);
                        currentFunctionCallName = function_call.name;
                    }
                    if (function_call.arguments) {
                        res.write(function_call.arguments);
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
        }

        if (currentMessageFromGPT.trim().length > 0) {
            messages.push({
                role: ChatCompletionRequestMessageRoleEnum.Assistant,
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
                    role: ChatCompletionRequestMessageRoleEnum.Assistant,
                    content: "",
                    function_call: {
                        name: functionCall.name,
                        arguments: JSON.stringify(args),
                    },
                });
                messages.push({
                    role: ChatCompletionRequestMessageRoleEnum.Function,
                    content: JSON.stringify(funcRes),
                    name: functionCall.name,
                });
            }
        }

        if (!shouldRecurse || currentMessageFromGPT.includes(finString)) {
            debug("currentMessageFromGPT: %s", currentMessageFromGPT)
            debug("LOC 2. Finished. Returning true.")
            res.end();
        } else {
            // otherwise, continue recursing
            debug("currentMessageFromGPT: %s", currentMessageFromGPT)
            debug("Not finished yet. Recursively calling oaf with messages: %o", messages)
            const isFinished = await callOafHelper(messages, res, openai, options, true);
            if (isFinished) {
                if (!isRecursive) {
                    debug("LOC 3. Finished. Returning true.")
                    res.end();
                }
                return true;
            }
        }
    } catch (e) {
        debug("Error: %o", e);
        res.emit("error", e);
        res.end();
    }
}