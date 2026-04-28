export interface TTSProvider {
  synthesize(text: string, voiceId: string): Promise<Buffer>;
}
