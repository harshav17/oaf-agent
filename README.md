## Debugging oaf
Run the following command from consumer
```
DEBUG=oaf:* node dist/index.js
```

## Linking oaf locally (while its still unpublished)
```
npm link ../oaf 
```

## example code to use the library
```
async function main() {
    const finString = "[finished]";
    let messages: ChatCompletionRequestMessage[] = [
        {
            role: ChatCompletionRequestMessageRoleEnum.System,
            content: dedent`
                You are an assistant augmented with the functions provided. 
                Utilize them to complete the tasks given to you.
                
                You Must Always:
                1. Think step by step
                2. Once you think you have given the answer, you should respond with ${finString}.
            `,
        },
        {
            role: ChatCompletionRequestMessageRoleEnum.User,
            content: "What is 27 + 35 + 42 + A3 + B4 + C5?",
        }
    ];
    const stream = new Writable({
        write(chunk, encoding, callback) {
          console.log(chunk.toString());
          callback();
        },
    });
    stream.on('error', (err) => {
        console.error(err);
    });

    const funs: Record<string, (...args: any[]) => any> = funcs;
    await callOaf(messages, stream, funs, functionsForModel, configuration, finString);
}
```