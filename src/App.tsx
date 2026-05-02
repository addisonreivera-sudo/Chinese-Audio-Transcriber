import { useState, useRef, useEffect, ChangeEvent, DragEvent } from 'react';
import { FileAudio, UploadCloud, Download, Loader2, PlayCircle, Pause, Clock, Trash2, FileText, Copy, Check } from 'lucide-react';

interface TranscriptSegment {
  startTime: string;
  endTime: string;
  speaker?: string;
  text: string;
  khmerText: string;
}

function parseSrtTime(srtTime: string): number {
  const parts = srtTime.split(',');
  const hms = parts[0].split(':');
  const hours = parseInt(hms[0], 10);
  const minutes = parseInt(hms[1], 10);
  const seconds = parseInt(hms[2], 10);
  const ms = parts[1] ? parseInt(parts[1], 10) : 0;
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [includeSpeakerLabels, setIncludeSpeakerLabels] = useState(true);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

  const activeIndex = transcripts.findIndex(seg => {
    const start = parseSrtTime(seg.startTime);
    const end = parseSrtTime(seg.endTime);
    return currentTime >= start && currentTime <= end;
  });

  useEffect(() => {
    if (activeIndex !== -1 && segmentRefs.current[activeIndex]) {
      segmentRefs.current[activeIndex]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [activeIndex]);

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file);
      setAudioUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setAudioUrl(null);
    }
  }, [file]);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.type.startsWith('audio/') || droppedFile.name.endsWith('.mp3') || droppedFile.name.endsWith('.wav')) {
        setFile(droppedFile);
        setError(null);
      } else {
        setError("Please drop a valid audio file (mp3, wav, m4a, etc).");
      }
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    if (file.size > 20 * 1024 * 1024) {
      setError("File is too large. For browser-based processing, please upload an audio file smaller than 20MB.");
      return;
    }

    setIsUploading(true);
    setTranscripts([]);
    setError(null);
    setUploadProgress(0);

    const progressInterval = setInterval(() => {
      setUploadProgress(prev => {
        const next = prev + (Math.random() * 5 + 2);
        return next > 95 ? 95 : next;
      });
    }, 500);

    try {
      const { GoogleGenAI, Type } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY });
      
      const reader = new FileReader();
      const base64Data = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const prompt = `Transcribe the following Chinese audio. Output the transcription as a JSON array of objects, with each object containing 'startTime' (string, e.g., '00:00:01,000' using exact SRT time format of HH:MM:SS,mmm), 'endTime' (string, also HH:MM:SS,mmm format), 'speaker' (string, identify the speaker, e.g. 'Speaker 1', 'Speaker 2'), 'text' (Chinese text spoken), and 'khmerText' (Accurate, natural-sounding Khmer translation of the Chinese text). Respond ONLY with valid JSON.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: [
          {
            inlineData: {
              mimeType: file.type || "audio/mp3",
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
      setTranscripts(JSON.parse(jsonText.trim()));

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
      clearInterval(progressInterval);
      setUploadProgress(100);
      setTimeout(() => {
        setIsUploading(false);
      }, 500);
    }
  };

  const downloadSrt = (lang: 'zh' | 'km') => {
    if (transcripts.length === 0) return;

    const srtContent = transcripts
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
    a.download = `${file?.name || "transcription"}_${lang}.srt`;
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

  const updateSegment = (index: number, field: 'text' | 'khmerText', newText: string) => {
    setTranscripts(prev => {
      const newTranscripts = [...prev];
      newTranscripts[index] = {
        ...newTranscripts[index],
        [field]: newText
      };
      return newTranscripts;
    });
  };

  const handleCopy = (text: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  return (
    <div className="bg-[#0F1115] text-[#E0E0E0] min-h-screen flex flex-col font-sans antialiased overflow-hidden">
      <header className="flex items-center justify-between px-6 md:px-8 py-6 border-b border-white/5">
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

      <main className="flex flex-1 flex-col md:flex-row overflow-hidden">
        {/* Left Sidebar: Controls */}
        <aside className="w-full md:w-[320px] border-b md:border-b-0 md:border-r border-white/5 p-6 flex flex-col gap-6 flex-shrink-0 bg-[#0F1115]">
          <section className="flex flex-col gap-6">
            <div>
              <label className="text-[11px] uppercase tracking-[0.2em] text-white/40 block mb-3">
                {file ? "Active File" : "Upload Audio"}
              </label>
              {!file ? (
                <div
                  className="bg-white/[0.02] border border-dashed border-white/10 rounded-xl p-8 hover:bg-white/5 hover:border-white/20 transition-all cursor-pointer flex flex-col items-center justify-center text-center group"
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="h-12 w-12 bg-white/5 group-hover:scale-110 transition-transform rounded-full flex items-center justify-center mb-4">
                    <UploadCloud className="w-5 h-5 text-indigo-400/80" />
                  </div>
                  <h3 className="text-sm font-medium mb-1 text-white/90">Click to upload</h3>
                  <p className="text-xs text-white/40 max-w-xs mx-auto">MP3, WAV, M4A up to 20MB</p>
                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    accept="audio/*"
                    onChange={handleFileChange}
                  />
                </div>
              ) : (
                <div className="bg-black/20 p-4 rounded-xl border border-white/5 flex flex-col gap-4 shadow-sm">
                   <div className="flex items-center justify-between">
                     <div className="flex-1 overflow-hidden">
                       <p className="text-sm font-medium truncate text-white/90" title={file.name}>{file.name}</p>
                       <p className="text-xs text-white/40 mt-0.5">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                     </div>
                     {!isUploading && (
                        <button
                          onClick={() => { setFile(null); setTranscripts([]); setError(null); setAudioUrl(null); }}
                          className="p-2 ml-3 text-white/30 hover:text-red-400 hover:bg-white/5 rounded-lg transition-colors"
                          title="Remove file"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                     )}
                   </div>
                   
                   {audioUrl && (
                      <div className="rounded-lg overflow-hidden bg-black/40 p-1 border border-white/5">
                        <audio 
                          ref={audioRef}
                          src={audioUrl} 
                          controls 
                          className="w-full h-8 outline-none opacity-80 hover:opacity-100 transition-opacity" 
                          style={{ colorScheme: "dark" }}
                          onTimeUpdate={handleTimeUpdate}
                          onPlay={() => setIsPlaying(true)}
                          onPause={() => setIsPlaying(false)}
                        />
                      </div>
                   )}
                </div>
              )}
            </div>
            
            {error && (
              <div className="p-4 border border-red-500/20 bg-red-500/10 text-red-400 rounded-xl text-xs leading-relaxed">
                {error}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-4">
            {isUploading && (
              <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] text-indigo-300 uppercase tracking-widest font-medium">Progress</p>
                  <p className="text-[10px] text-indigo-300/80">{Math.round(uploadProgress)}%</p>
                </div>
                <div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-indigo-500 transition-all duration-500 ease-out relative" 
                    style={{ width: `${uploadProgress}%` }}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent w-[200%] animate-[shimmer_2s_infinite]"></div>
                  </div>
                </div>
              </div>
            )}
            
            {!transcripts.length && file && (
               <button
                  disabled={isUploading}
                  onClick={handleUpload}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/20"
                >
                  {isUploading ? <Loader2 className="w-4 h-4 animate-spin text-white/80" /> : <PlayCircle className="w-4 h-4 text-white/80" />}
                  <span>{isUploading ? 'Processing...' : 'Transcribe Audio'}</span>
                </button>
            )}

            {transcripts.length > 0 && (
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
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => downloadSrt('zh')}
                      className="w-full bg-white/[0.03] hover:bg-white/[0.08] text-white font-medium py-3 px-4 rounded-xl flex items-center justify-between transition-colors border border-white/[0.05] text-sm group"
                      title="Download Chinese SRT"
                    >
                      <span>Chinese (.srt)</span>
                      <Download className="w-4 h-4 opacity-40 group-hover:opacity-100 transition-opacity group-hover:scale-110" />
                    </button>
                    <button
                      onClick={() => downloadSrt('km')}
                      className="w-full bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 font-medium py-3 px-4 rounded-xl flex items-center justify-between transition-colors border border-indigo-500/30 text-sm group"
                      title="Download Khmer SRT"
                    >
                      <span className="text-indigo-300 group-hover:text-indigo-200 transition-colors">Khmer (.srt)</span>
                      <Download className="w-4 h-4 opacity-70 group-hover:opacity-100 transition-opacity group-hover:scale-110 group-hover:text-indigo-200" />
                    </button>
                  </div>
               </div>
            )}
          </section>
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
                <div className="flex gap-4">
                  <button className="text-xs px-4 py-1.5 rounded bg-white/10 text-white">Transcript View</button>
                </div>
                {transcripts.length > 0 && (
                   <div className="text-xs text-white/30">Showing {transcripts.length} cues</div>
                )}
              </div>
              
              <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-6 md:p-8">
                 {isUploading ? (
                    <div className="h-full flex flex-col items-center justify-center text-white/40 space-y-4">
                       <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                       <p className="text-sm">Our Neural Engine is processing the audio layer...</p>
                    </div>
                 ) : (
                   <div className="space-y-1">
                      {transcripts.map((seg, idx) => {
                         const startSeconds = parseSrtTime(seg.startTime);
                         const endSeconds = parseSrtTime(seg.endTime);
                         const isActive = currentTime >= startSeconds && currentTime <= endSeconds;
                         
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
                             </div>
                             <div className="flex-1 w-full flex flex-col gap-1.5 focus-within:ring-0">
                               {seg.speaker && (
                                 <div className="text-[11px] uppercase tracking-wider text-indigo-300 font-medium mb-0.5">
                                   {seg.speaker}
                                 </div>
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
        </section>
      </main>
    </div>
  );
}
