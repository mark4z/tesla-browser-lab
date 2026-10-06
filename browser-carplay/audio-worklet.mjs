import { PcmMixer } from './audio-core.mjs?v=browser-av-v3';

class DiPlayPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mixer = new PcmMixer(sampleRate);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'reset') this.mixer.reset(data.epoch);
      else if (data.type === 'pcm') {
        this.mixer.push(data.buffer);
        // Back-pressure credits bound main-thread -> audio-thread queued transfer memory.
        this.port.postMessage({ type: 'consumed', serial: data.serial });
      } else if (data.type === 'stop') {
        this.mixer.stop(data.epoch, data.streamId, data.lastSample);
        this.port.postMessage({ type: 'consumed', serial: data.serial });
      }
    };
  }
  process(_inputs, outputs) {
    const stereo = outputs[0];
    if (stereo?.length === 2) this.mixer.render(stereo[0], stereo[1]);
    return true;
  }
}
registerProcessor('diplay-pcm', DiPlayPcmProcessor);
