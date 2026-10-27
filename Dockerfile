FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    tzdata \
    cpulimit \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ .

ENV DATA_DIR=/data
ENV TZ=America/New_York
ENV PYTHONDONTWRITEBYTECODE=1
VOLUME ["/data"]
EXPOSE 8420

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8420"]
