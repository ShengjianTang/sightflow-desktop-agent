export interface VisionClient {
  detectVision(prompt: string, imageBase64: string): Promise<string>
}
