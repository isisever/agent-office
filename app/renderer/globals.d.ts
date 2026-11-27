// Renderer globals: the preload bridge (see CONTRACT.md). Detailed types can be added later.
interface Window {
  agentOffice: any
}

// AudioWorklet scope (renderer/voice-worklet.js, contract v3.119)
declare class AudioWorkletProcessor { port: MessagePort; constructor(); }
declare function registerProcessor(name: string, ctor: any): void;
declare const sampleRate: number;
