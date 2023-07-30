import { ChatCompletionRequestMessageRoleEnum, ChatCompletionRequestMessage, Configuration, OpenAIApi, ChatCompletionFunctions } from "openai";
import { IncomingMessage } from "http";
import { Writable } from "node:stream";
import debugModule from "debug";

const decoder = new TextDecoder("utf-8");
const debug = debugModule("oaf:core");

export async function callOaf(messages: ChatCompletionRequestMessage[], res: Writable, funcs: any, funcDescs: ChatCompletionFunctions[], configuration: Configuration, finString: string) {
    const openai = new OpenAIApi(configuration);
    debug("Started oaf with messages: %o", messages);
    await callOafHelper(messages, res, false, openai, funcs, funcDescs, finString);
}

async function callOafHelper(messages: ChatCompletionRequestMessage[], res: Writable, isRecursive: boolean = false, openai: OpenAIApi, funcs: any, funcDescs: ChatCompletionFunctions[], finString: string) {
    let functionCalls: any[] = [];
    let currentFunctionCallName = "";
    let currentMessageFromGPT = "";
    debug("Started oaf with funcs: %o", funcDescs);
    try {
        const completion = await openai.createChatCompletion(
            {
                model: "gpt-4-0613", // TODO: Make this configurable
                messages: messages,
                stream: true,
                max_tokens: 1000,
                temperature: 0.5,
                functions: funcDescs,
                function_call: "auto",
            },
            { responseType: "stream" },
        );

        const stream = completion.data as unknown as IncomingMessage;

        for await (const chunk of stream) {
            const value = decoder.decode(chunk);
            const lines = value.split("\n");
            const parsedLines: any = lines
                .map((line) => line.replace("data: ", "")) // Remove the "data: " prefix
                .filter((line) => line !== "" && line !== "[DONE]") // Remove empty lines and "[DONE]"
                .map((line) => {
                    return JSON.parse(line);
                });

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
                        currentFunctionCallName = function_call.name;
                    }
                    if (function_call.arguments) {
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
                const args = JSON.parse(functionCall.argsString);
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
                    content: funcRes,
                    name: functionCall.name,
                });

                debug("Recursively calling oaf with messages: %o", messages)
                const isFinished = await callOafHelper(messages, res, true, openai, funcs, funcDescs, finString);
                if (isFinished) {
                    if (!isRecursive) {
                        debug("Finished. Returning true.")
                        res.end();
                    }
                    return true;
                }
            }
        }


        if (currentMessageFromGPT.trim().length === 0 || currentMessageFromGPT.includes(finString)) {
            if (!isRecursive) {
                debug("Finished. Returning true.")
                res.end();
            }
            return true;
        } else {
            // otherwise, continue recursing
            debug("currentMessageFromGPT: %s, finString: %s", currentMessageFromGPT, finString)
            debug("Not finished yet. Recursively calling oaf with messages: %o", messages)
            const isFinished = await callOafHelper(messages, res, true, openai, funcs, funcDescs, finString);
            if (isFinished) {
                if (!isRecursive) {
                    debug("Finished. Returning true.")
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