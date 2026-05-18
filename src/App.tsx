import { useState, useRef, useEffect, ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { FileAudio, UploadCloud, Download, Loader2, PlayCircle, Pause, Clock, Trash2, FileText, Copy, Check, Terminal, StopCircle } from 'lucide-react';

interface TranscriptSegment {
  startTime: string;
  endTime: string;
  startMs: number;
  endMs: number;
  localStartMs?: number;
  localEndMs?: number;
  queueIndex?: number;
  rawStartMs?: number;
  rawEndMs?: number;
  speaker?: string;
  text: string;
  khmerText: string;
}

function parseSrtTime(srtTime: string): number {
  if (!srtTime.includes(':')) return 0;
  const parts = srtTime.split(',');
  const hms = parts[0].split(':');
  const hours = parseInt(hms[0] || '0', 10);
  const minutes = parseInt(hms[1] || '0', 10);
  const seconds = parseInt(hms[2] || '0', 10);
  const ms = parts[1] ? parseInt(parts[1], 10) : 0;
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

function formatSrtTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const ms = Math.floor((totalSeconds % 1) * 1000);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

function getRetryDelayMs(errorMessage: string) {
  const match = errorMessage.match(/retry in\s+([\d.]+)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 2000;
  return 60000;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizePartCues(rawCues: any[], file: any) {
  if (!file || typeof file.durationMs !== 'number') return rawCues;
  const maxMs = file.durationMs + 10000;

  return rawCues
    .filter(cue => cue.startMs >= 0 && cue.startMs <= maxMs)
    .map(cue => ({
      ...cue,
      startMs: Math.min(cue.startMs, file.durationMs),
      endMs: Math.min(cue.endMs, file.durationMs),
    }))
    .filter(cue => cue.endMs > cue.startMs);
}

function addSrtTimeOffset(srtTime: string, offsetSec: number): string {
  const currentSec = parseSrtTime(srtTime);
  return formatSrtTime(currentSec + offsetSec);
}

function detectErrorCode(message: string): string {
  const msg = message.toLowerCase();
  if (msg.includes("429") || msg.includes("quota") || msg.includes("rate limit")) return "rate_limit";
  if (msg.includes("payload too large") || msg.includes("413")) return "file_too_large";
  if (msg.includes("network error") || msg.includes("fetch failed") || msg.includes("timeout")) return "network_error";
  if (msg.includes("safety")) return "safety_block";
  if (msg.includes("json")) return "parse_error";
  return "unknown_error";
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [queueState, setQueueState] = useState<{
    fileName: string, 
    status: 'pending' | 'done' | 'failed' | 'transcribing' | 'MissingFile', 
    size: number, 
    durationMs?: number, 
    queueIndex: number,
    errorMessage?: string,
    errorCode?: string,
    failedAt?: string,
    retryCount?: number,
    fileObject?: File
  }[]>([]);
  const [isProjectLoaded, setIsProjectLoaded] = useState(false);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [transcriptionProgressMessage, setTranscriptionProgressMessage] = useState<string>('');
  const [detailedProgress, setDetailedProgress] = useState<{currentChunk: number, totalChunks: number} | null>(null);
  const [fastMode, setFastMode] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [transcripts, setTranscripts] = useState<(TranscriptSegment & {fileId: string, partName: string})[]>([]);
  const [isTranscriptIncomplete, setIsTranscriptIncomplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [includeSpeakerLabels, setIncludeSpeakerLabels] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [exportSpeaker, setExportSpeaker] = useState<string>('All');
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uniqueSpeakers = Array.from(new Set(transcripts.map(seg => seg.speaker).filter(Boolean))) as string[];
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

  const stopRequestedRef = useRef(false);
  const [countdown, setCountdown] = useState<number>(0);
  const [isPaused, setIsPaused] = useState(false);

  const failedParts = queueState?.filter(q => q.status === 'failed') ?? [];

  useEffect(() => {
    const saved = localStorage.getItem('shengyin-project-v2');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.transcripts && Array.isArray(parsed.transcripts)) setTranscripts(parsed.transcripts);
        if (parsed.queueState && Array.isArray(parsed.queueState)) setQueueState(parsed.queueState);
      } catch(e) {
        console.error("Failed to restore project state", e);
        localStorage.removeItem('shengyin-project-v2');
      }
    }
    setIsProjectLoaded(true);
  }, []);

  useEffect(() => {
    if (isProjectLoaded) {
       const queueToSave = queueState.map(({fileObject, ...rest}) => rest);
       localStorage.setItem('shengyin-project-v2', JSON.stringify({ transcripts, queueState: queueToSave }));
    }
  }, [transcripts, queueState, isProjectLoaded]);

  const activeIndex = transcripts.findIndex((seg, idx) => {
    const startSeconds = parseSrtTime(seg.startTime);
    const nextStartSeconds = idx < transcripts.length - 1 ? parseSrtTime(transcripts[idx + 1].startTime) : Infinity;
    return currentTime >= startSeconds && currentTime < nextStartSeconds;
  });

  useEffect(() => {
    if (autoScroll && activeIndex !== -1 && segmentRefs.current[activeIndex] && scrollContainerRef.current) {
      const el = segmentRefs.current[activeIndex];
      const container = scrollContainerRef.current;
      if (el && container) {
        const elTop = el.offsetTop;
        const elHeight = el.offsetHeight;
        const containerHeight = container.offsetHeight;
        
        container.scrollTo({
          top: elTop - containerHeight / 2 + elHeight / 2,
          behavior: 'smooth'
        });
      }
    }
  }, [activeIndex, autoScroll]);

  // Auto-scroll to bottom as new parts of the transcript are added during generation
  useEffect(() => {
    if (autoScroll && (isUploading || isPaused || queueState.some(q=>q.status==='failed')) && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [transcripts.length, autoScroll, isUploading, isPaused, queueState]);

  useEffect(() => {
    if (files.length > 0) {
      const url = URL.createObjectURL(files[0]);
      setAudioUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setAudioUrl(null);
    }
  }, [files]);

  const resetFileInput = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const getAudioDuration = (file: File): Promise<number> => {
    return new Promise((resolve) => {
      const audio = new Audio(URL.createObjectURL(file));
      audio.onloadedmetadata = () => {
        resolve(audio.duration * 1000);
        URL.revokeObjectURL(audio.src);
      };
    });
  };

  const integrateFiles = async (newFiles: File[]) => {
    const filesWithDuration = await Promise.all(
        newFiles.map(async f => ({ file: f, durationMs: await getAudioDuration(f) }))
    );

    setFiles(prev => {
        const merged = [...prev];
        newFiles.forEach(nf => {
            if (!merged.find(f => f.name === nf.name)) merged.push(nf);
        });
        return merged;
    });
    
    setQueueState(prev => {
       let merged = [...prev];
       const maxIndex = merged.length > 0 ? Math.max(...merged.map(q => q.queueIndex)) : -1;
       
       filesWithDuration.forEach(({file, durationMs}, i) => {
          const existing = merged.find(q => q.fileName === file.name && q.size === file.size);
          if (existing) {
             existing.fileObject = file;
             existing.status = existing.status === 'MissingFile' ? 'pending' : existing.status;
          } else {
             merged.push({ 
                 fileName: file.name, 
                 status: 'pending', 
                 size: file.size, 
                 durationMs, 
                 queueIndex: maxIndex + 1 + i,
                 fileObject: file
             });
          }
       });
       return merged;
    });
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const allFiles = Array.from(e.dataTransfer.files) as File[];
      const droppedFiles = allFiles.filter(f => f.type.startsWith('audio/') || f.name.endsWith('.mp3') || f.name.endsWith('.wav') || f.name.endsWith('.m4a'));
      if (droppedFiles.length > 0) {
        integrateFiles(droppedFiles);
        setError(null);
      } else {
        setError("Please drop a valid audio file (mp3, wav, m4a, etc).");
      }
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFiles = Array.from(e.target.files) as File[];
      integrateFiles(selectedFiles);
      setError(null);
      resetFileInput();
    }
  };

  const getOffsetMs = (queueItem: any, queue: any[]) => {
    return queue
      .filter(f => f.queueIndex < queueItem.queueIndex)
      .reduce((sum, f) => sum + (f.durationMs || 0), 0);
  };

  const handleUpload = () => {
    setTranscripts([]);
    setQueueState(prev => prev.map(q => ({...q, status: 'pending'})));
    startTranscription(false);
  };

  const handleStop = () => {
    stopRequestedRef.current = true;
    setIsPaused(true);
  };

  const handleResume = () => {
    startTranscription(false);
  };

  const handleRetryFailed = () => {
    startTranscription(true);
  };

  const normalizeCue = (cue: any, queueItem: any, queue: any[]) => {
    const rawStartMs = cue.rawStartMs ?? (parseSrtTime(cue.startTime) * 1000);
    const rawEndMs = cue.rawEndMs ?? (parseSrtTime(cue.endTime) * 1000);
    
    const localStartMs = Math.max(0, Math.min(rawStartMs, queueItem.durationMs || 0));
    const localEndMs = Math.max(localStartMs, Math.min(rawEndMs, queueItem.durationMs || 0));
    
    const offsetMs = getOffsetMs(queueItem, queue);
    const startMs = offsetMs + localStartMs;
    const endMs = offsetMs + localEndMs;
    
    return {
      ...cue,
      fileId: queueItem.fileName,
      partName: queueItem.fileName,
      queueIndex: queueItem.queueIndex,
      rawStartMs,
      rawEndMs,
      localStartMs,
      localEndMs,
      offsetMs,
      startMs,
      endMs,
      startTime: formatSrtTime(startMs / 1000),
      endTime: formatSrtTime(endMs / 1000),
    };
  };

  const updateFileStatus = (fileName: string, status: 'done' | 'failed', error?: any) => {
    setQueueState(prev => prev.map(q => {
      if (q.fileName === fileName) {
        return {
          ...q,
          status,
          errorMessage: status === 'failed' ? (error?.message || String(error)) : undefined,
          errorCode: status === 'failed' ? detectErrorCode(error?.message || String(error)) : undefined,
          failedAt: status === 'failed' ? new Date().toISOString() : undefined,
          retryCount: status === 'failed' ? ((q.retryCount || 0) + 1) : q.retryCount
        };
      }
      return q;
    }));
  };

  const startTranscription = async (retryFailed: boolean = false) => {
    console.log("Starting transcription...");
    if (queueState.length === 0) return;

    const itemsToProcess = queueState.filter(q => 
       q.status === 'pending' || (retryFailed && q.status === 'failed')
    );

    if (itemsToProcess.length === 0) return;

    const missingFiles = itemsToProcess.filter(q => !q.fileObject);
    if (missingFiles.length > 0) {
       for (const mf of missingFiles) {
          updateFileStatus(mf.fileName, 'failed', new Error("File missing. Please upload/rebind file."));
          console.log("Missing file object", mf.fileName);
       }
       setError(`Missing files in memory for: ${missingFiles.map(m=>m.fileName).join(', ')}. Please use 'Add parts' to re-select them.`);
       return;
    }

    if (itemsToProcess.some(f => f.fileObject && f.size > 20 * 1024 * 1024)) {
       setError("One or more files exceed 20MB...");
       return;
    }

    setIsUploading(true);
    setIsPaused(false);
    stopRequestedRef.current = false;
    setIsTranscriptIncomplete(false);
    setError(null);
    setUploadProgress(0);

    try {
      const { GoogleGenAI, Type } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: (import.meta as any).env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY });
      
      for (let i = 0; i < queueState.length; i++) {
        if (stopRequestedRef.current) break;

        const currentQueueItem = queueState[i];
        if (currentQueueItem.status === 'done') continue;
        if (!retryFailed && currentQueueItem.status === 'failed') continue;

        const currentFile = currentQueueItem.fileObject;
        if (!currentFile) {
            updateFileStatus(currentQueueItem.fileName, 'failed', new Error("File missing."));
            setError(`Missing file ${currentQueueItem.fileName} during run!`);
            break; 
        }

        const cacheKey = `ts_part_${currentFile.name}_${currentFile.size}`;

        if (!retryFailed || currentQueueItem.status !== 'failed') {
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                try {
                    const parsedCache = JSON.parse(cached);
                    const adjustedChunk = parsedCache.map((seg: any) => normalizeCue(seg, currentQueueItem, queueState));
                    setTranscripts(prev => [
                        ...prev.filter(cue => cue.fileId !== currentQueueItem.fileName),
                        ...adjustedChunk
                    ].sort((a, b) => (a.queueIndex || 0) - (b.queueIndex || 0) || (a.localStartMs || 0) - (b.localStartMs || 0)));
                    
                    setQueueState(prev => prev.map(q => q.fileName === currentQueueItem.fileName ? { ...q, status: 'done' } : q));
                    setUploadProgress(Math.round(((i + 1) / queueState.length) * 100));
                    continue; // Skip API call
                } catch(e) {
                   console.log("Failed to parse cache, re-transcribing...");
                }
            }
        }

        // Delay between chunks to respect rate limits (30s delay if not the first part)
        if (transcripts.length > 0 && (!retryFailed || i !== queueState.findIndex(q => q.status === 'failed'))) {
            setTranscriptionProgressMessage(`Waiting 30s to avoid rate limit...`);
            for(let c = 30; c > 0; c--) {
                if (stopRequestedRef.current) return;
                setCountdown(c);
                await new Promise(r => setTimeout(r, 1000));
            }
            setCountdown(0);
        }

        let success = false;
        let retryCount = 0;
        let parsedChunk: TranscriptSegment[] = [];
        let lastError = null;

        while (!success && retryCount < 3) {
            if (stopRequestedRef.current) return;
            setDetailedProgress({ currentChunk: i + 1, totalChunks: queueState.length });
            setUploadProgress(Math.round(((i) / queueState.length) * 100));

            try {
                setTranscriptionProgressMessage(`Transcribing part ${i + 1} of ${queueState.length} (${currentFile.name})${retryCount > 0 ? ` [Retry ${retryCount}/3]` : ''}...`);
                
                const arrayBuffer = await currentFile.arrayBuffer();
                let binary = '';
                const bytes = new Uint8Array(arrayBuffer);
                const len = bytes.byteLength;
                for (let j = 0; j < len; j++) {
                    binary += String.fromCharCode(bytes[j]);
                }
                const base64Data = btoa(binary);
                
                let previousContext = '';
                if (transcripts.length > 0) {
                  const lastSegs = transcripts.slice(-5);
                  previousContext = lastSegs.map(s => `${s.speaker || 'Unknown'}: ${s.text}`).join('\n');
                }

                const prompt = `Transcribe the following Chinese audio. Output the transcription as a JSON array of objects, with each object containing 'startTime' (string, e.g., '00:00:01,000' using exact SRT time format of HH:MM:SS,mmm), 'endTime' (string, also HH:MM:SS,mmm format), 'speaker' (string, identify the speaker, e.g. 'Speaker 1', 'Speaker 2'), 'text' (Chinese text spoken), and 'khmerText' (Accurate, natural-sounding Khmer translation of the Chinese text). Respond ONLY with valid JSON.\n\nCRITICAL: You are transcribing audio segment "${currentFile.name}". Timestamps MUST be relative to the start of THIS SPECIFIC audio file segment (00:00:00 to ${Math.floor((currentQueueItem.durationMs || 0) / 1000 / 60) + 1}:00). DO NOT include offsets of previous audio parts in your timestamps.` + 
                (previousContext ? `\n\nFor context and to maintain speaker continuity, the previous spoken lines from the preceding audio part were:\n${previousContext}\n\nPlease continue the transcription using the same speaker labels where applicable.` : '');

                const response = await ai.models.generateContent({
                  model: "gemini-flash-latest",
                  contents: [
                    {
                      inlineData: {
                        mimeType: currentFile.type || "audio/mp3",
                        data: base64Data,
                      }
                    },
                    { text: prompt }
                  ],
                  config: {
                    responseMimeType: "application/json",
                    responseSchema: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          startTime: { type: Type.STRING, description: "Start time in HH:MM:SS,mmm format" },
                          endTime: { type: Type.STRING, description: "End time in HH:MM:SS,mmm format" },
                          speaker: { type: Type.STRING, description: "Identify the speaker, e.g., 'Speaker 1', 'Speaker 2'" },
                          text: { type: Type.STRING, description: "Transcribed Chinese text" },
                          khmerText: { type: Type.STRING, description: "Highly accurate and natural Khmer translation" }
                        },
                        required: ["startTime", "endTime", "speaker", "text", "khmerText"]
                      }
                    },
                    systemInstruction: "You are an expert bilingual transcription and translation assistant. Produce highly accurate transcription and culturally natural, grammatically correct Khmer translations. Ensure cultural nuances are preserved in the Khmer text. Follow JSON schema exactly and strictly output an array."
                  }
                });

                let jsonText = response.text || "[]";
                try {
                  jsonText = jsonText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
                  parsedChunk = JSON.parse(jsonText.trim());
                } catch (e) {
                  console.warn("Failed to parse chunk JSON completely:", e);
                  try {
                    const lastBraceIdx = jsonText.lastIndexOf('}');
                    if (lastBraceIdx !== -1) {
                      const partialJson = jsonText.substring(0, lastBraceIdx + 1) + ']';
                      parsedChunk = JSON.parse(partialJson);
                    }
                  } catch(e2) {
                    console.error("Failed to recover partial JSON:", e2);
                  }
                }
                
                localStorage.setItem(cacheKey, JSON.stringify(parsedChunk));
                setQueueState(prev => prev.map(q => q.fileName === currentQueueItem.fileName ? { ...q, status: 'done', errorMessage: undefined, errorCode: undefined, failedAt: undefined } : q));
                success = true;
            } catch (err: any) {
                lastError = err;
                const msg = String(err?.message || err).toLowerCase();
                const isRateLimit = msg.includes("resource_exhausted") || msg.includes("429") || msg.includes("quota") || msg.includes("rate limit");
                
                if (isRateLimit && retryCount < 2) {
                    retryCount++;
                    const delayMs = getRetryDelayMs(msg);
                    setTranscriptionProgressMessage(`Rate limited. Waiting ${Math.ceil(delayMs / 1000)}s before retry ${retryCount}/3...`);
                    await sleep(delayMs);
                } else {
                    console.error("API error during part transcribing:", err);
                    break;
                }
            }
        }

        if (success) {
            const rawCues = parsedChunk.map((cue: any) => ({
                 ...cue,
                 startMs: parseSrtTime(cue.startTime) * 1000,
                 endMs: parseSrtTime(cue.endTime) * 1000
            }));
            const localCues = sanitizePartCues(rawCues, currentQueueItem);
            
            const rejectedCount = parsedChunk.length - localCues.length;
            if (parsedChunk.length > 0 && rejectedCount / parsedChunk.length > 0.2) {
               console.warn(`Part ${i+1} rejected ${rejectedCount} cues out of ${parsedChunk.length}. Marking failed.`);
               updateFileStatus(currentQueueItem.fileName, 'failed', new Error("Bad timestamps from Gemini, retry this part."));
            } else {
               const adjustedChunk = localCues.map(seg => normalizeCue(seg, currentQueueItem, queueState));

               setTranscripts(prev => [
                   ...prev.filter(cue => cue.fileId !== currentQueueItem.fileName),
                   ...adjustedChunk
               ].sort((a, b) => (a.queueIndex || 0) - (b.queueIndex || 0) || (a.localStartMs || 0) - (b.localStartMs || 0)));
            }
        } else {
            console.warn(`Part ${i+1} failed after retries.`);
            updateFileStatus(currentQueueItem.fileName, 'failed', lastError);
        }
      }

      if (stopRequestedRef.current) {
         setTranscriptionProgressMessage('Paused');
         return;
      }

      const hasFailed = queueState.some(q => q.status === 'failed');
      if (hasFailed) {
          setTranscriptionProgressMessage(`Completed processing. Some parts failed.`);
      } else {
          setTranscriptionProgressMessage('Success!');
      }
      setUploadProgress(100);

    } catch (err: any) {
      console.error("Transcription Error:", err);
      let errMsg = "An unexpected error occurred while transcribing.";
      
      if (err instanceof SyntaxError || (err.message && err.message.includes("JSON"))) {
         errMsg = "The AI returned an invalid format. Please try again or use a clearer audio clip.";
      } else if (err.message) {
         const msg = err.message.toLowerCase();
         if (msg.includes("api key not valid") || msg.includes("missing api key") || msg.includes("gemini_api_key")) {
            errMsg = "Missing or Invalid Gemini API Key! Please configure a valid API key in the AI Studio Settings (Secrets) panel in the top right.";
         } else if (msg.includes("quota") || msg.includes("429") || msg.includes("rate limit")) {
            errMsg = "You have exceeded your API quota or rate limit. Please try again later.";
         } else if (msg.includes("overloaded") || msg.includes("503") || msg.includes("500") || msg.includes("internal error")) {
            errMsg = "The AI service is currently overloaded or experiencing issues. Please wait a moment and try again.";
         } else if (msg.includes("payload too large") || msg.includes("413") || msg.includes("too large")) {
            errMsg = "The audio file is too large for the API to process directly. Please use a smaller file (under 20MB).";
         } else if (msg.includes("network error") || msg.includes("fetch failed")) {
            errMsg = "Network error. Please check your internet connection.";
         } else {
            errMsg = err.message; 
         }
      }
      setError(errMsg);
    } finally {
      setUploadProgress(100);
      setTimeout(() => {
        setIsUploading(false);
        setTranscriptionProgressMessage('');
        setDetailedProgress(null);
      }, 500);
    }
  };

  const handleContinueTranscription = async () => {
    if (files.length === 0 || transcripts.length === 0) return;
    const lastSeg = transcripts[transcripts.length - 1];
    if (!lastSeg) return;

    setIsUploading(true);
    setTranscriptionProgressMessage('Continuing transcription...');
    setError(null);
    setUploadProgress(0);

    try {
      const { GoogleGenAI, Type } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: (import.meta as any).env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY });
      
      const currentFile = files[0];
      const arrayBuffer = await currentFile.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(arrayBuffer);
      const len = bytes.byteLength;
      for (let j = 0; j < len; j++) {
          binary += String.fromCharCode(bytes[j]);
      }
      const base64Data = btoa(binary);
      
      const lastSegs = transcripts.slice(-5);
      const previousContext = lastSegs.map(s => `${s.speaker || 'Unknown'}: ${s.text}`).join('\n');

      const prompt = `Transcribe the following Chinese audio. Output the transcription as a JSON array of objects, with each object containing 'startTime' (string, e.g., '00:00:01,000' using exact SRT time format of HH:MM:SS,mmm), 'endTime' (string, also HH:MM:SS,mmm format), 'speaker' (string, identify the speaker, e.g. 'Speaker 1', 'Speaker 2'), 'text' (Chinese text spoken), and 'khmerText' (Accurate, natural-sounding Khmer translation of the Chinese text). Respond ONLY with valid JSON.\n\nCRITICAL INSTRUCTION: The transcription previously stopped at ${lastSeg.endTime}. You MUST completely IGNORE all audio before ${lastSeg.endTime}. Start transcribing EXACTLY from timestamp ${lastSeg.endTime} and continue until the end of the file. Output timestamps accurately reflecting the actual time in the audio file.\n\nFor context and to maintain speaker continuity, the previous spoken lines before ${lastSeg.endTime} were:\n${previousContext}\n\nPlease continue the transcription using the same speaker labels where applicable.`;

      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: [
          {
            inlineData: {
              mimeType: currentFile.type || "audio/mp3",
              data: base64Data,
            }
          },
          { text: prompt }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                startTime: { type: Type.STRING, description: "Start time in HH:MM:SS,mmm format" },
                endTime: { type: Type.STRING, description: "End time in HH:MM:SS,mmm format" },
                speaker: { type: Type.STRING, description: "Identify the speaker, e.g., 'Speaker 1', 'Speaker 2'" },
                text: { type: Type.STRING, description: "Transcribed Chinese text" },
                khmerText: { type: Type.STRING, description: "Highly accurate and natural Khmer translation" }
              },
              required: ["startTime", "endTime", "speaker", "text", "khmerText"]
            }
          },
          systemInstruction: "You are an expert bilingual transcription and translation assistant. Produce highly accurate transcription and culturally natural, grammatically correct Khmer translations. Ensure cultural nuances are preserved in the Khmer text. Follow JSON schema exactly and strictly output an array."
        }
      });

      let jsonText = response.text || "[]";
      let parsedChunk: TranscriptSegment[] = [];
      try {
        jsonText = jsonText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
        parsedChunk = JSON.parse(jsonText.trim());
      } catch (e) {
        console.warn("Failed to parse chunk JSON completely:", e);
        try {
          const lastBraceIdx = jsonText.lastIndexOf('}');
          if (lastBraceIdx !== -1) {
            const partialJson = jsonText.substring(0, lastBraceIdx + 1) + ']';
            parsedChunk = JSON.parse(partialJson);
          }
        } catch(e2) {
          console.error("Failed to recover partial JSON:", e2);
        }
      }

      const currentFileObj = files[0];
      const currentQueueItemObj = queueState.find(q => q.fileName === currentFileObj?.name);

      const rawCues = parsedChunk.map((cue: any) => ({
           ...cue,
           startMs: parseSrtTime(cue.startTime) * 1000,
           endMs: parseSrtTime(cue.endTime) * 1000
      }));
      const localCues = sanitizePartCues(rawCues, currentQueueItemObj);

      const allTranscripts = [...transcripts, ...localCues.map(seg => normalizeCue(seg, currentQueueItemObj, queueState))]
         .sort((a, b) => (a.queueIndex || 0) - (b.queueIndex || 0) || (a.localStartMs || 0) - (b.localStartMs || 0));
      
      setTranscripts(allTranscripts);

      if (audioRef.current && audioRef.current.duration > 0 && allTranscripts.length > 0) {
        const duration = audioRef.current.duration;
        const newLastSeg = allTranscripts[allTranscripts.length - 1];
        if (newLastSeg) {
          const lastEnd = parseSrtTime(newLastSeg.endTime);
          if (lastEnd < duration - 60) {
            setIsTranscriptIncomplete(true);
          } else {
            setIsTranscriptIncomplete(false);
          }
        }
      }
      
      setTranscriptionProgressMessage('Merging transcripts...');
      setUploadProgress(100);
    } catch (err: any) {
      console.error("Transcription Error:", err);
      setError("An unexpected error occurred while transcribing: " + (err.message || ''));
    } finally {
      setTimeout(() => {
        setIsUploading(false);
        setTranscriptionProgressMessage('');
      }, 500);
    }
  };

  const copyAll = (lang: 'zh' | 'km') => {
    if (transcripts.length === 0) return;

    const filteredTranscripts = exportSpeaker === 'All'
      ? transcripts
      : transcripts.filter(seg => seg.speaker === exportSpeaker);

    const content = filteredTranscripts
      .map(seg => {
        const speakerPrefix = (includeSpeakerLabels && seg.speaker) ? `${seg.speaker}: ` : '';
        return speakerPrefix + (lang === 'zh' ? seg.text : (seg.khmerText || seg.text));
      })
      .join("\n");

    navigator.clipboard.writeText(content);
    setCopiedText(`all-${lang}`);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const downloadSrt = (lang: 'zh' | 'km') => {
    if (transcripts.length === 0) return;

    const totalProjectDurationMs = queueState.reduce((sum, q) => sum + (q.durationMs || 0), 0);
    const maxExportMs = totalProjectDurationMs + 10000;

    const exportFilteredTranscripts = transcripts.filter(seg => seg.startMs <= maxExportMs);

    const filteredTranscripts = exportSpeaker === 'All'
      ? exportFilteredTranscripts
      : exportFilteredTranscripts.filter(seg => seg.speaker === exportSpeaker);

    const srtContent = filteredTranscripts
      .map((seg, i) => {
        const speakerPrefix = (includeSpeakerLabels && seg.speaker) ? `${seg.speaker}: ` : '';
        const textContent = speakerPrefix + (lang === 'zh' ? seg.text : (seg.khmerText || seg.text));
        return `${i + 1}\n${seg.startTime.replace('.', ',')} --> ${seg.endTime.replace('.', ',')}\n${textContent}\n`;
      })
      .join("\n");

    const blob = new Blob([srtContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${files.length > 0 ? files[0].name.split('.')[0] : "transcription"}_${lang}.srt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
      
      // We could add auto-scroll logic here if desired
    }
  };

  const togglePlaySegment = (srtTime: string, isActive: boolean) => {
    if (audioRef.current) {
      if (isActive) {
        if (audioRef.current.paused) {
          audioRef.current.play().catch(e => console.error("Playback failed:", e));
        } else {
          audioRef.current.pause();
        }
      } else {
        const timeInSeconds = parseSrtTime(srtTime);
        audioRef.current.currentTime = timeInSeconds + 0.001; // tiny offset to trigger update reliably
        audioRef.current.play().catch(e => console.error("Playback failed:", e));
      }
    }
  };

  const updateSegment = (index: number, field: 'text' | 'khmerText' | 'speaker', newText: string) => {
    setTranscripts(prev => {
      const newTranscripts = [...prev];
      newTranscripts[index] = {
        ...newTranscripts[index],
        [field]: newText
      };
      return newTranscripts;
    });
  };

  const handleCopy = (text: string, e: ReactMouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  return (
    <div className="bg-[#0F1115] text-[#E0E0E0] h-screen flex flex-col font-sans antialiased overflow-hidden">
      <header className="flex items-center justify-between px-6 md:px-8 py-6 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-500 rounded-sm flex items-center justify-center font-bold text-white">S</div>
          <h1 className="text-xl font-medium tracking-tight">ShengYin <span className="text-white/40 font-light">Transcription</span></h1>
        </div>
        <div className="hidden sm:flex items-center gap-6 text-sm text-white/60">
           {isUploading ? (
              <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-indigo-400" /> Processing...</span>
           ) : (
              <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-green-500"></span> Engine Active</span>
           )}
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden min-h-0">
        {/* Left Sidebar: Controls */}
        <aside className="w-[320px] shrink-0 overflow-y-auto border-r border-white/5 bg-[#0F1115] h-full flex flex-col">
          <div className="p-6 flex flex-col gap-6 flex-1">
            <section className="flex flex-col gap-6">
            <div>
              <label className="text-[11px] uppercase tracking-[0.2em] text-white/40 block mb-3">
                {files.length > 0 ? "Uploaded Files" : "Upload Audio"}
              </label>
              
              <div
                className="bg-white/[0.02] border border-dashed border-white/10 rounded-xl p-6 hover:bg-white/5 hover:border-white/20 transition-all cursor-pointer flex flex-col items-center justify-center text-center group mb-4"
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="h-10 w-10 bg-white/5 group-hover:scale-110 transition-transform rounded-full flex items-center justify-center mb-3">
                  <UploadCloud className="w-4 h-4 text-indigo-400/80" />
                </div>
                <h3 className="text-sm font-medium mb-1 text-white/90">Add parts</h3>
                <p className="text-[11px] text-white/40 max-w-xs mx-auto">MP3, WAV, M4A up to 20MB per part</p>
                <input
                  type="file"
                  multiple
                  ref={fileInputRef}
                  className="hidden"
                  accept="audio/*"
                  onChange={handleFileChange}
                />
              </div>

              {queueState.length > 0 && (
                <div className="bg-black/20 p-4 rounded-xl border border-white/5 flex flex-col gap-4 shadow-sm mb-4">
                  <div className="flex items-center justify-between pb-2 border-b border-white/5">
                     <span className="text-xs text-white/60">Project Queue ({queueState.length})</span>
                     <button onClick={() => {
                          Object.keys(localStorage).forEach(key => {
                              if (key.startsWith('ts_part_')) {
                                  localStorage.removeItem(key);
                              }
                          });
                          alert("Cache cleared!");
                       }} className="text-[10px] text-white/50 hover:text-white/80 hover:bg-white/5 px-2 py-1 rounded transition-colors">Clear Cache</button>
                      <button onClick={() => {
                        setQueueState([]);
                        setTranscripts([]);
                        setFiles([]);
                        localStorage.removeItem('shengyin-project-v2');
                        resetFileInput();
                     }} className="text-[10px] text-red-400 hover:bg-red-500/10 px-2 py-1 rounded transition-colors">Clear Project</button>
                  </div>
                  <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-2">
                    {queueState.map((qItem, i) => {
                      const fileInMemory = files.find(f => f.name === qItem.fileName);
                      return (
                        <div key={i} className="flex flex-col bg-white/[0.02] p-2 rounded-lg border border-white/5">
                          <div className="flex items-center justify-between">
                            <div className="flex-1 overflow-hidden min-w-0 pr-2">
                              <p className="text-xs font-medium truncate text-white/80" title={qItem.fileName}>{qItem.fileName}</p>
                              <div className="text-[10px] text-white/40 mt-0.5">
                                 {((qItem.durationMs || 0) / 1000 / 60).toFixed(1)} mins | Offset: {(getOffsetMs(qItem, queueState) / 1000 / 60).toFixed(1)}m
                              </div>
                              <div className="flex items-center gap-2 mt-0.5">
                                 <span className="text-[10px] text-white/40">{(qItem.size / (1024 * 1024)).toFixed(2)} MB</span>
                                 {qItem.status === 'done' && <span className="text-[10px] text-green-400 font-medium">Done</span>}
                                 {qItem.status === 'failed' && <span className="text-[10px] text-red-400 font-medium">Failed</span>}
                                 {qItem.status === 'MissingFile' && <span className="text-[10px] text-orange-400 font-medium">Missing File</span>}
                                 {(qItem.status === 'pending' || qItem.status === 'transcribing') && <span className="text-[10px] text-indigo-400 font-medium">{isUploading && (files.length > 0 && files[0].name === qItem.fileName) ? 'Transcribing...' : (qItem.status === 'transcribing' ? 'Transcribing...' : 'Pending')}</span>}
                              </div>
                              {qItem.status === 'failed' && qItem.errorMessage && (
                                <div className="text-[10px] text-red-400 mt-1 truncate" title={qItem.errorMessage}>Failed: {qItem.errorMessage}</div>
                              )}
                              {qItem.status === 'MissingFile' && (
                                <div className="text-[10px] text-orange-400 mt-1 truncate">Please re-upload this file</div>
                              )}
                            </div>
                            
                            <div className="flex items-center gap-1">
                                {qItem.status === 'failed' && (
                                    <>
                                        <button onClick={() => navigator.clipboard.writeText(qItem.errorMessage || "No error details")} className="p-1.5 text-white/30 hover:text-white/80 rounded-lg">
                                            <Copy className="w-3 h-3" />
                                        </button>
                                        <button onClick={() => startTranscription(true)} className="p-1.5 text-orange-400 hover:bg-orange-500/10 rounded-lg">Retry</button>
                                    </>
                                )}
                                {!isUploading && (
                                  <button
                                    onClick={() => { 
                                      const newFiles = files.filter(f => f.name !== qItem.fileName);
                                      setFiles(newFiles); 
                                      setQueueState(prev => prev.filter(q => q.fileName !== qItem.fileName));
                                      if (newFiles.length === 0) setAudioUrl(null); 
                                      resetFileInput();
                                    }}
                                    className="p-1.5 text-white/30 hover:text-red-400 hover:bg-white/5 rounded-lg transition-colors"
                                    title="Remove file"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  
                  {/* Total Duration */}
                  <div className="mt-2 text-[10px] text-white/40 text-right">
                    Total project duration: {(queueState.reduce((sum, q) => sum + (q.durationMs || 0), 0) / 1000 / 60).toFixed(1)} mins
                  </div>
                  
                  {/* Start Button */}
                   {queueState.length > 0 && !isUploading && (
                      <button
                         onClick={handleUpload}
                         disabled={queueState.every(q => q.status === 'done')}
                         className="w-full mt-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2 rounded-lg flex items-center justify-center gap-2 transition-colors shadow-lg shadow-indigo-500/20 text-xs"
                      >
                         <PlayCircle className="w-4 h-4" />
                         <span>{queueState.some(q=>q.status==='failed') ? 'Retry Failed' : 'Start Transcribe All'}</span>
                      </button>
                   )}
                </div>
              )}
            </div>

            <div className="p-4 bg-white/[0.02] border border-white/10 rounded-xl space-y-3">
              <h4 className="text-xs font-semibold text-white/80 uppercase tracking-widest flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5" />
                Large Files (1H+)
              </h4>
              <p className="text-xs text-white/50 leading-relaxed">
                Browser memory limits files to 20MB. For long recordings, compress or split them using <span className="text-white/80">FFmpeg</span> on your computer first, then upload the parts here.
              </p>
              <div className="space-y-2">
                <div className="bg-black/40 rounded p-2 border border-white/5 group relative">
                  <p className="text-[10px] text-white/30 mb-1">Compress (Low Bitrate)</p>
                  <code className="text-[10px] font-mono text-indigo-300 break-all select-all">ffmpeg -i "input.mp3" -ac 1 -ar 16000 -b:a 32k "small.mp3"</code>
                </div>
                <div className="bg-black/40 rounded p-2 border border-white/5 group relative">
                  <p className="text-[10px] text-white/30 mb-1">Split (5-min parts) *</p>
                  <code className="text-[10px] font-mono text-indigo-300 break-all select-all">ffmpeg -i "input.mp3" -f segment -segment_time 300 -c copy "part_%03d.mp3"</code>
                </div>
              </div>
              <p className="text-[10px] text-white/40 italic mt-2">* Upload multiple parts simultaneously. They will be transcribed sequentially and merged.</p>
            </div>
            
            {error && (
              <div className="p-4 border border-red-500/20 bg-red-500/10 text-red-400 rounded-xl text-xs leading-relaxed">
                {error}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-4">
            {queueState.length > 0 && !transcripts.length && (
               <div className="space-y-4">
                 {/* Only show fast mode if not started yet */}
                 {!isUploading && !isPaused && !queueState.some(q=>q.status==='failed') && (
                   <label className="flex items-center justify-between p-3 bg-white/[0.03] border border-white/5 rounded-xl cursor-pointer hover:bg-white/[0.06] transition-colors group">
                     <div className="flex flex-col">
                       <span className="text-sm text-white/90 font-medium">Fast Mode</span>
                       <span className="text-[10px] text-white/40">Uses less memory, slightly lower accuracy</span>
                     </div>
                     <div className={`w-10 h-5 rounded-full transition-colors relative flex-shrink-0 ${fastMode ? 'bg-indigo-500' : 'bg-white/10'}`}>
                       <div className={`absolute top-[2px] left-[2px] w-4 h-4 rounded-full bg-white transition-transform ${fastMode ? 'translate-x-5' : 'translate-x-0'}`}></div>
                     </div>
                     <input 
                       type="checkbox"
                       className="sr-only"
                       checked={fastMode}
                       onChange={(e) => setFastMode(e.target.checked)}
                       disabled={isUploading}
                     />
                   </label>
                 )}
                 
                 {!isUploading && !isPaused && !failedParts.length && (
                   <button
                      onClick={handleUpload}
                      className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 rounded-xl flex items-center justify-center gap-2 transition-colors shadow-lg shadow-indigo-500/20"
                    >
                      <PlayCircle className="w-4 h-4 text-white/80" />
                      <span>Transcribe Audio</span>
                    </button>
                 )}
               </div>
            )}

            {transcripts.length > 0 && !isUploading && !isPaused && isTranscriptIncomplete && (
              <div className="space-y-4 pb-6 border-t border-white/5 pt-6 text-left">
                <div className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-xl space-y-3">
                  <h4 className="text-xs font-semibold text-orange-400 uppercase tracking-widest flex items-center gap-2">
                    <Clock className="w-3.5 h-3.5" />
                    Transcript Incomplete
                  </h4>
                  <p className="text-xs text-orange-200/70 leading-relaxed">
                    The transcription stopped before the end of the audio file. This can happen with very long recordings. 
                    Last processed timestamp: {transcripts[transcripts.length - 1]?.endTime}
                  </p>
                  <button
                    onClick={handleContinueTranscription}
                    disabled={isUploading}
                    className="w-full mt-2 bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 font-medium py-2.5 rounded-lg flex items-center justify-center gap-2 transition-colors border border-orange-500/30 disabled:opacity-50"
                  >
                    {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                    <span>{isUploading ? 'Continuing...' : 'Continue Transcription'}</span>
                  </button>
                </div>
              </div>
            )}

            {transcripts.length > 0 && !isUploading && !isPaused && !isTranscriptIncomplete && (
               <div className="space-y-4 pb-6 text-left border-t border-white/5 pt-6">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-white/40 uppercase tracking-widest font-medium">Export Transcripts</p>
                    <label className="flex items-center gap-2 cursor-pointer group">
                      <span className="text-[10px] text-white/40 uppercase tracking-wider group-hover:text-white/60 transition-colors">Labels</span>
                      <div className={`w-8 h-4 rounded-full transition-colors relative ${includeSpeakerLabels ? 'bg-indigo-500' : 'bg-white/10'}`}>
                        <div className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${includeSpeakerLabels ? 'translate-x-4' : 'translate-x-0'}`}></div>
                      </div>
                      <input 
                        type="checkbox"
                        className="sr-only"
                        checked={includeSpeakerLabels}
                        onChange={(e) => setIncludeSpeakerLabels(e.target.checked)}
                      />
                    </label>
                  </div>
                  <div className="flex flex-col gap-3">
                    {uniqueSpeakers.length > 0 && (
                      <div className="bg-white/[0.02] border border-white/5 rounded-lg px-3 py-2 flex items-center justify-between">
                        <span className="text-xs text-white/50">Filter Speaker</span>
                        <select
                          className="bg-transparent text-sm text-white focus:outline-none appearance-none text-right cursor-pointer"
                          value={exportSpeaker}
                          onChange={(e) => setExportSpeaker(e.target.value)}
                        >
                          <option className="bg-[#0A0C10] text-white" value="All">All Speakers</option>
                          {uniqueSpeakers.map(speaker => (
                            <option className="bg-[#0A0C10] text-white" key={speaker} value={speaker}>{speaker}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2">
                        <button
                          onClick={() => downloadSrt('zh')}
                          className="flex-1 bg-white/[0.03] hover:bg-white/[0.08] text-white font-medium py-3 px-4 rounded-xl flex items-center justify-between transition-colors border border-white/[0.05] text-sm group"
                          title="Download Chinese SRT"
                        >
                          <span>Chinese (.srt)</span>
                          <Download className="w-4 h-4 opacity-40 group-hover:opacity-100 transition-opacity group-hover:scale-110" />
                        </button>
                        <button
                          onClick={() => copyAll('zh')}
                          className="px-4 bg-white/[0.03] hover:bg-white/[0.08] text-white font-medium rounded-xl flex items-center justify-center transition-colors border border-white/[0.05]"
                          title="Copy Chinese text"
                        >
                          {copiedText === 'all-zh' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 opacity-40" />}
                        </button>
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={() => downloadSrt('km')}
                          className="flex-1 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 font-medium py-3 px-4 rounded-xl flex items-center justify-between transition-colors border border-indigo-500/30 text-sm group"
                          title="Download Khmer SRT"
                        >
                          <span className="text-indigo-300 group-hover:text-indigo-200 transition-colors">Khmer (.srt)</span>
                          <Download className="w-4 h-4 opacity-70 group-hover:opacity-100 transition-opacity group-hover:scale-110 group-hover:text-indigo-200" />
                        </button>
                        <button
                          onClick={() => copyAll('km')}
                          className="px-4 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 font-medium rounded-xl flex items-center justify-center transition-colors border border-indigo-500/30"
                          title="Copy Khmer text"
                        >
                          {copiedText === 'all-km' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 opacity-70" />}
                        </button>
                      </div>
                    </div>
                  </div>
               </div>
            )}
          </section>
          </div>
        </aside>

        {/* Main Content: Timeline */}
        <section className="flex-1 bg-[#0A0C10] flex flex-col overflow-hidden relative">
           {!transcripts.length && !isUploading ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-white/30">
                 <FileAudio className="w-16 h-16 mb-4 opacity-20" />
                 <p className="text-lg font-medium">No transcript available</p>
                 <p className="text-sm mt-2">Upload an audio document to extract Chinese transcription</p>
              </div>
           ) : (
             <>
               <div className="flex items-center justify-between px-6 md:px-8 py-4 bg-white/[0.02] border-b border-white/5">
                <div className="flex gap-4 items-center">
                  <button className="text-xs px-4 py-1.5 rounded bg-white/10 text-white">Transcript View</button>
                  <label className="flex items-center gap-2 cursor-pointer group ml-2">
                    <div className={`w-7 h-3.5 rounded-full transition-colors relative flex-shrink-0 ${autoScroll ? 'bg-indigo-500' : 'bg-white/10'}`}>
                      <div className={`absolute top-[2px] left-[2px] w-2.5 h-2.5 rounded-full bg-white transition-transform ${autoScroll ? 'translate-x-[14px]' : 'translate-x-0'}`}></div>
                    </div>
                    <span className="text-[11px] text-white/50 uppercase tracking-wider group-hover:text-white/80 transition-colors mt-px">Auto-scroll</span>
                    <input 
                      type="checkbox"
                      className="sr-only"
                      checked={autoScroll}
                      onChange={(e) => setAutoScroll(e.target.checked)}
                    />
                  </label>
                </div>
                {transcripts.length > 0 && (
                   <div className="text-xs text-white/30">Showing {transcripts.length} cues</div>
                )}
              </div>
              
              <div ref={scrollContainerRef} onWheel={() => { if (autoScroll) setAutoScroll(false); }} onTouchMove={() => { if (autoScroll) setAutoScroll(false); }} className={`flex-1 overflow-y-auto p-6 md:p-8 ${(isUploading || isPaused || failedParts.length > 0) && files.length > 0 ? 'pb-32 md:pb-32' : ''}`}>
                 {isUploading && transcripts.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-white/40 space-y-4">
                       <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                       <div className="text-center space-y-2">
                         <p className="text-sm font-medium text-white/80">{transcriptionProgressMessage || 'Preparing audio for chunking...'}</p>
                         {detailedProgress && (
                           <div className="space-y-1">
                             <p className="text-xs text-indigo-400">
                               Part {detailedProgress.currentChunk} / {detailedProgress.totalChunks}
                             </p>
                           </div>
                         )}
                       </div>
                    </div>
                 ) : (
                   <div className="space-y-1">
                      {transcripts.map((seg, idx) => {
                         const isActive = idx === activeIndex;
                         
                         return (
                           <div 
                             key={idx} 
                             ref={(el) => (segmentRefs.current[idx] = el)}
                             onClick={() => togglePlaySegment(seg.startTime, isActive)}
                             className={`cursor-pointer grid grid-cols-[80px_1fr] md:grid-cols-[100px_1fr] gap-4 md:gap-8 py-4 border-b border-white/5 px-4 -mx-4 rounded-xl items-start transition-all duration-300 group
                               ${isActive ? 'bg-indigo-500/10 border-indigo-500/30' : 'hover:bg-white/[0.02]'}`}
                           >
                             <div className={`font-mono text-xs py-1 whitespace-nowrap transition-colors flex items-center gap-2 ${isActive ? 'text-indigo-400 font-medium' : 'text-white/40 group-hover:text-indigo-300'}`}>
                                 {isActive ? (
                                   <div className="relative flex items-center justify-center w-4 h-4">
                                     {isPlaying ? (
                                       <Pause className="w-4 h-4 animate-pulse absolute" />
                                     ) : (
                                       <PlayCircle className="w-4 h-4 absolute opacity-80" />
                                     )}
                                   </div>
                                ) : (
                                   <div className="relative flex items-center justify-center w-4 h-4">
                                     <Clock className="w-3 h-3 group-hover:opacity-0 transition-opacity absolute" />
                                     <PlayCircle className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity absolute" />
                                   </div>
                                )}
                                <span>{seg.startTime.split(',')[0]}</span>
                                <span className="text-[9px] text-white/20 select-none">| {seg.partName} | {formatSrtTime(seg.offsetMs / 1000).split(',')[0]}</span>
                             </div>
                             <div className="flex-1 w-full flex flex-col gap-1.5 focus-within:ring-0">
                               {seg.speaker !== undefined && (
                                 <input
                                   type="text"
                                   value={seg.speaker}
                                   onClick={(e) => e.stopPropagation()}
                                   onChange={(e) => updateSegment(idx, 'speaker', e.target.value)}
                                   className="text-[11px] uppercase tracking-wider text-indigo-300 font-medium mb-0.5 bg-transparent border-none outline-none focus:bg-white/[0.05] hover:bg-white/[0.02] px-1 py-0.5 -ml-1 rounded transition-colors w-auto max-w-[150px] focus:ring-1 focus:ring-white/10"
                                   placeholder="Speaker name"
                                 />
                               )}
                               <div className="flex items-start gap-2 group/text relative">
                                 <div
                                   contentEditable
                                   suppressContentEditableWarning
                                   onClick={(e) => e.stopPropagation()}
                                   onBlur={(e) => updateSegment(idx, 'text', e.currentTarget.textContent || '')}
                                   className={`outline-none flex-1 block w-full text-base md:text-lg leading-relaxed transition-colors px-2 py-0.5 -mx-2 rounded cursor-text hover:bg-white/[0.03] focus:bg-white/[0.05] focus:ring-1 focus:ring-white/10 ${isActive ? 'text-white' : 'text-white/70'}`}
                                 >
                                   {seg.text}
                                 </div>
                                 <button
                                   onClick={(e) => handleCopy(seg.text, e)}
                                   className="p-1.5 rounded-lg opacity-0 group-hover/text:opacity-100 hover:bg-white/10 text-white/40 hover:text-white transition-all mt-0.5 shrink-0"
                                   title="Copy Chinese text"
                                 >
                                   {copiedText === seg.text ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                                 </button>
                               </div>
                               {seg.khmerText && (
                                 <div className="flex items-start gap-2 group/khmer relative">
                                   <div
                                     contentEditable
                                     suppressContentEditableWarning
                                     onClick={(e) => e.stopPropagation()}
                                     onBlur={(e) => updateSegment(idx, 'khmerText', e.currentTarget.textContent || '')}
                                     className={`outline-none flex-1 block w-full text-sm md:text-base leading-relaxed transition-colors px-2 py-0.5 -mx-2 rounded cursor-text hover:bg-white/[0.03] focus:bg-white/[0.05] focus:ring-1 focus:ring-white/10 ${isActive ? 'text-indigo-200' : 'text-white/40'}`}
                                   >
                                     {seg.khmerText}
                                   </div>
                                   <button
                                     onClick={(e) => handleCopy(seg.khmerText, e)}
                                     className="p-1.5 rounded-lg opacity-0 group-hover/khmer:opacity-100 hover:bg-white/10 text-white/30 hover:text-white transition-all mt-0.5 shrink-0"
                                     title="Copy Khmer text"
                                   >
                                     {copiedText === seg.khmerText ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                                   </button>
                                 </div>
                               )}
                             </div>
                           </div>
                         );
                      })}
                   </div>
                 )}
              </div>
            </>
           )}

           {/* Sticky Bottom Progress Bar */}
           {(isUploading || isPaused || queueState.some(q=>q.status==='failed' || q.status==='pending')) && queueState.length > 0 && (
              <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-white/10 bg-black/80 backdrop-blur-xl shrink-0 z-10 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
                <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center gap-4">
                  <div className="flex-1 w-full space-y-2">
                    <div className="flex justify-between items-center text-xs font-medium">
                      <span className="text-white/80">{transcriptionProgressMessage || 'Preparing...'}
                        {countdown > 0 && <span className="text-orange-400 ml-2">Waiting {countdown}s...</span>}
                      </span>
                      <span className="text-indigo-400">{Math.round(uploadProgress)}%
                        {detailedProgress && <span className="ml-2 text-white/40 font-normal">(Part {detailedProgress.currentChunk} / {detailedProgress.totalChunks})</span>}
                      </span>
                    </div>
                    <div className="h-2 w-full bg-black/50 border border-white/5 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-indigo-500 transition-all duration-500 ease-out relative" 
                        style={{ width: `${uploadProgress}%` }}
                      >
                        {isUploading && !isPaused && <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent w-[200%] animate-[shimmer_2s_infinite]"></div>}
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 flex gap-2 w-full md:w-auto">
                    {isUploading && !isPaused && (
                      <button
                        onClick={handleStop}
                        className="flex-1 md:flex-none px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 text-xs font-medium rounded-lg flex items-center justify-center gap-2 transition-colors border border-red-500/30"
                      >
                        <StopCircle className="w-4 h-4" />
                        <span>Pause</span>
                      </button>
                    )}
                    {!isUploading && isPaused && (
                       <button
                         onClick={handleResume}
                         className="flex-1 md:flex-none px-4 py-2 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 text-xs font-medium rounded-lg flex items-center justify-center gap-2 transition-colors border border-indigo-500/30"
                       >
                         <PlayCircle className="w-4 h-4" />
                         <span>Resume Remaining</span>
                       </button>
                    )}
                    {!isUploading && !isPaused && queueState.some(q=>q.status==='failed') && (
                       <button
                         onClick={handleRetryFailed}
                         className="flex-1 md:flex-none px-4 py-2 bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 text-xs font-medium rounded-lg flex items-center justify-center gap-2 transition-colors border border-orange-500/30"
                       >
                         <PlayCircle className="w-4 h-4" />
                         <span>Retry Failed</span>
                       </button>
                    )}
                  </div>
                </div>
              </div>
           )}
        </section>
      </main>
    </div>
  );
}
