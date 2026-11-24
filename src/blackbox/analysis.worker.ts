import { analyzeFile } from './analysis';
import type { AnalysisEvent } from './model';

interface AnalysisRequest {
  jobId: number;
  file: File;
}

const reply = (event: AnalysisEvent) => self.postMessage(event);

self.onmessage = async ({ data }: MessageEvent<AnalysisRequest>) => {
  try {
    await analyzeFile(data.file, reply, data.jobId);
  } catch (error) {
    reply({
      jobId: data.jobId,
      type: 'ANALYSIS_FAILED',
      message: error instanceof Error ? error.message : 'The file could not be analyzed.',
    });
  }
};
