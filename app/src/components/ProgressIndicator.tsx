import { useState, useEffect } from 'react';

export interface ProgressStep {
  label: string;
  estimatedSeconds: number;
}

interface ProgressIndicatorProps {
  steps: ProgressStep[];
  currentStep: number; // 0-indexed, -1 = not started
  error?: string | null;
  done?: boolean;
}

export default function ProgressIndicator({
  steps,
  currentStep,
  error,
  done,
}: ProgressIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);

  // Timer for current step
  useEffect(() => {
    if (currentStep < 0 || done || error) return;
    setElapsed(0);
    const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(interval);
  }, [currentStep, done, error]);

  const currentEstimate = currentStep >= 0 && currentStep < steps.length
    ? steps[currentStep].estimatedSeconds
    : 0;
  const remaining = Math.max(0, currentEstimate - elapsed);

  return (
    <div className="space-y-3">
      {steps.map((step, i) => {
        const isActive = i === currentStep && !done && !error;
        const isComplete = done ? true : i < currentStep;
        const isFailed = error && i === currentStep;
        const isPending = !done && i > currentStep;

        return (
          <div
            key={step.label}
            className={`flex items-center gap-3 p-3 rounded-xl transition-all ${
              isActive ? 'bg-cyan-600/10 border border-cyan-500/30' :
              isComplete ? 'bg-green-600/10 border border-green-500/20' :
              isFailed ? 'bg-red-600/10 border border-red-500/30' :
              'bg-zinc-800/50 border border-transparent'
            }`}
          >
            {/* Status icon */}
            <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs">
              {isComplete && (
                <span className="text-green-400">&#10003;</span>
              )}
              {isActive && (
                <span className="text-cyan-400 animate-spin inline-block">&#9696;</span>
              )}
              {isFailed && (
                <span className="text-red-400">&#10007;</span>
              )}
              {isPending && (
                <span className="text-zinc-600">{i + 1}</span>
              )}
            </div>

            {/* Label */}
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${
                isActive ? 'text-cyan-300' :
                isComplete ? 'text-green-400' :
                isFailed ? 'text-red-400' :
                'text-zinc-500'
              }`}>
                {step.label}
              </p>
              {isFailed && error && (
                <p className="text-red-400/70 text-xs mt-1">{error}</p>
              )}
            </div>

            {/* Timer */}
            {isActive && (
              <div className="text-right shrink-0">
                <span className="text-cyan-400/70 text-xs font-mono">
                  ~{remaining}s
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
