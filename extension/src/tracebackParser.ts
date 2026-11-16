export interface PythonTracebackFrame {
  file: string;
  line: number;
  functionName?: string;
}

export interface PythonTraceback {
  raw: string;
  exceptionType: string;
  message: string;
  frames: PythonTracebackFrame[];
}

export function parsePythonTraceback(raw: string): PythonTraceback | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }

  const frames = [...text.matchAll(
    /^\s*File "([^"\r\n]+)", line (\d+)(?:, in ([^\r\n]+))?\s*$/gm,
  )].map((match) => ({
    file: match[1],
    line: Number(match[2]),
    functionName: match[3]?.trim() || undefined,
  }));
  const exception = [...text.matchAll(
    /^\s*([A-Za-z_][\w.]*(?:Error|Exception|Warning|Interrupt|Exit|Iteration|StopIteration)?)(?::\s*(.*))?\s*$/gm,
  )].at(-1);

  if (!exception || frames.length === 0 || !Number.isInteger(frames[0].line)) {
    return undefined;
  }

  return {
    raw: text,
    exceptionType: exception[1],
    message: exception[2]?.trim() ?? '',
    frames,
  };
}
