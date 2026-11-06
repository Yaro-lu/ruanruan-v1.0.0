import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexPrompt,
  extractFirstSupportedMedia,
  extractVoiceTranscript,
  prepareMediaForCodex,
  type MediaPreparationDeps,
} from '../src/wechat/media.js';
import { MessageItemType, type MessageItem } from '../src/wechat/types.js';


test('extractFirstSupportedMedia finds supported non-text items in order', () => {
  const items: MessageItem[] = [
    { type: MessageItemType.TEXT, text_item: { text: 'hello' } },
    {
      type: MessageItemType.VOICE,
      voice_item: {
        media: {
          encrypt_query_param: 'voice-query',
          aes_key: 'voice-key',
        },
        text: '语音内容',
      },
    },
    {
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: 'image-query',
          aes_key: 'image-key',
        },
      },
    },
  ];

  const media = extractFirstSupportedMedia(items);
  assert.equal(media?.kind, 'voice');
  assert.equal(media?.item.type, MessageItemType.VOICE);
});

test('extractVoiceTranscript prefers the current text field', () => {
  const item: MessageItem = {
    type: MessageItemType.VOICE,
    voice_item: {
      media: {
        encrypt_query_param: 'voice-query',
        aes_key: 'voice-key',
      },
      text: '实时语音转写',
      voice_text: '旧字段',
    },
  };

  assert.equal(extractVoiceTranscript(item), '实时语音转写');
});

test('prepareMediaForCodex uses built-in transcript for voice messages', async () => {
  const item: MessageItem = {
    type: MessageItemType.VOICE,
    voice_item: {
      media: {
        encrypt_query_param: 'voice-query',
        aes_key: 'voice-key',
      },
      text: '发音频，你识别不了吗',
    },
  };

  const result = await prepareMediaForCodex({ kind: 'voice', item });

  assert.equal(result.defaultPrompt, '请根据下面的微信语音转写内容回答用户。');
  assert.equal(result.promptFragments[0], '微信语音转写：\n发音频，你识别不了吗');
  assert.match(result.promptFragments[1], /同音字、漏词/);
  assert.equal(result.voiceTranscript?.confidence, null);
  assert.deepEqual(result.imagePaths, []);
  assert.deepEqual(result.tempFiles, []);
  assert.equal(result.immediateReply, undefined);
});

test('prepareMediaForCodex transcribes audio files before calling Codex', async () => {
  const item: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: 'file-query',
        aes_key: 'file-key',
      },
      file_name: 'demo.mp3',
    },
  };

  const deps: MediaPreparationDeps = {
    downloadBinaryMediaToTemp: async () => '/tmp/demo.mp3',
    probeMedia: async () => ({
      durationSeconds: 42,
      hasAudio: true,
      hasVideo: false,
    }),
    extractAudioForTranscription: async () => '/tmp/demo.wav',
    extractVideoPreviewImage: async () => {
      throw new Error('video preview should not be used for plain audio');
    },
    transcribeAudio: async () => '这里是音频内容',
  };

  const result = await prepareMediaForCodex({ kind: 'audio', item }, deps);

  assert.equal(result.defaultPrompt, '请根据下面的微信音频转写内容回答用户。');
  assert.deepEqual(result.promptFragments, [
    '音频文件：demo.mp3',
    '音频转写：\n这里是音频内容',
  ]);
  assert.deepEqual(result.imagePaths, []);
  assert.deepEqual(result.tempFiles, ['/tmp/demo.mp3', '/tmp/demo.wav']);
});

test('prepareMediaForCodex extracts preview image and transcript for videos', async () => {
  const item: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: 'video-query',
        aes_key: 'video-key',
      },
      play_length: 3,
    },
  };

  const deps: MediaPreparationDeps = {
    downloadBinaryMediaToTemp: async () => '/tmp/demo.mp4',
    probeMedia: async () => ({
      durationSeconds: 3,
      hasAudio: true,
      hasVideo: true,
    }),
    extractAudioForTranscription: async () => '/tmp/demo.wav',
    extractVideoPreviewImage: async () => '/tmp/demo.jpg',
    transcribeAudio: async () => '视频里说你好',
  };

  const result = await prepareMediaForCodex({ kind: 'video', item }, deps);

  assert.equal(result.defaultPrompt, '请结合下面的视频关键帧和语音转写内容回答用户。');
  assert.deepEqual(result.promptFragments, [
    '视频时长：3 秒',
    '视频语音转写：\n视频里说你好',
  ]);
  assert.deepEqual(result.imagePaths, ['/tmp/demo.jpg']);
  assert.deepEqual(result.tempFiles, ['/tmp/demo.mp4', '/tmp/demo.jpg', '/tmp/demo.wav']);
});

test('buildCodexPrompt combines user text with media context', () => {
  const prompt = buildCodexPrompt('帮我总结一下', {
    kind: 'audio',
    defaultPrompt: '请根据下面的微信音频转写内容回答用户。',
    promptFragments: ['音频转写：\n这里是音频内容'],
    imagePaths: [],
    tempFiles: [],
  });

  assert.equal(prompt, '帮我总结一下\n\n音频转写：\n这里是音频内容');
});

test('prepareMediaForCodex rejects oversized audio with a direct reply', async () => {
  const item: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: 'file-query',
        aes_key: 'file-key',
      },
      file_name: 'long.mp3',
    },
  };

  const deps: MediaPreparationDeps = {
    downloadBinaryMediaToTemp: async () => '/tmp/long.mp3',
    probeMedia: async () => ({
      durationSeconds: 601,
      hasAudio: true,
      hasVideo: false,
    }),
    extractAudioForTranscription: async () => '/tmp/long.wav',
    extractVideoPreviewImage: async () => '/tmp/long.jpg',
    transcribeAudio: async () => 'should not run',
  };

  const result = await prepareMediaForCodex({ kind: 'audio', item }, deps);

  assert.equal(
    result.immediateReply,
    '⚠️ 音频已收到，但当前只自动处理 10 分钟内的音频。请截短后重发。',
  );
});
