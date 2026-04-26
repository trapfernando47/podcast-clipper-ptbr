# 🎙️ Podcast Clipper PT-BR

Automated pipeline for cutting, captioning, and formatting podcast clips 
into viral 9:16 short-form videos for TikTok, Reels and Shorts.

Built with Python, FFmpeg, and OpenAI Whisper.

## Features
- Auto-selects best clips from podcast audio using Reap API
- Generates animated captions with FFmpeg + Whisper transcription
- Outputs 50-70s vertical clips (9:16) ready for social media
- Supports Finance, Health, and AI/Career niches
- Batch processes 90+ clips per niche

## Requirements
- Python 3.10+
- FFmpeg 8.x
- openai-whisper
- Reap API key

## Quick Start
pip install -r requirements.txt
python main.py --niche finance --clips 30

## Use Case
Content creators in Portuguese-speaking markets who want to repurpose 
long-form podcast content into high-converting short clips without 
manual editing.
