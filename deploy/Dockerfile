FROM python:3.12-slim

WORKDIR /app

# System deps for OCR/imaging added in Phase 3; minimal for now
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt fastapi uvicorn python-multipart

COPY mediconsult ./mediconsult

ENV PYTHONUNBUFFERED=1
ENV MEDICONSULT_DATA=/data

# Default command overridden by docker-compose per service
CMD ["python", "-m", "mediconsult.mcp_server.remote_server"]
