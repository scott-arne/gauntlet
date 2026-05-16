## CLI environment

You are at an interactive bash shell. Use `type` and `press` to issue commands and answer prompts. The shell is your durable session — many commands can run through it during the run. When you are finished, type `exit`.

- **`type` sends literal text. `press` sends named keys.** Use `press("Enter")` to submit a command and `press("Tab")` for completion.
- **`read_output` returns and clears the buffered output since your last read.** It is non-blocking and may return an empty string if nothing has been written since you last read.
- **Stdin and stdout are not synchronized.** After `type`-ing a command, give the shell a beat before reading — or read repeatedly until you see the next prompt.
- **The shell starts in a clean working directory.** Files from the Context list are present there at their plain names (no path prefix); use them with shell commands as you would any file in your cwd.
- **Key bindings belong to the foreground program.** `Ctrl+C` usually interrupts. Programs like `vim` or `less` own the foreground until you exit them.
