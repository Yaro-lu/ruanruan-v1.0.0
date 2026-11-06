FROM ghcr.io/nickrunning/wechat-selkies@sha256:aefb35f900b3c821ae38830e88053d19a860e5be6960e25e2999de28d8e35d15
RUN /lsiopy/bin/python3 -m venv --system-site-packages /opt/ruanruan-reader && \
    /opt/ruanruan-reader/bin/pip install --no-cache-dir \
      sqlcipher3-binary==0.6.0 protobuf==6.31.1 lxml==6.0.0 \
      xmltodict==0.14.2 zstandard==0.23.0 rapidocr-onnxruntime==1.4.4
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3.12-dev && rm -rf /var/lib/apt/lists/*
RUN /opt/ruanruan-reader/bin/pip install --no-cache-dir --no-deps setuptools==80.9.0 wheel==0.45.1 typing_extensions==4.15.0
RUN printf '%s\n' 'pilk==0.2.4 --hash=sha256:d4a1bcf93dc6ef5e95e0cfd728ed4ef4d49f9c0476d70816fecbe456cc762e7f' > /tmp/voice-requirements.txt && \
    /opt/ruanruan-reader/bin/pip install --no-cache-dir --no-build-isolation --no-deps --require-hashes -r /tmp/voice-requirements.txt && \
    rm /tmp/voice-requirements.txt
COPY upstream/src /opt/wechat-ai/src
COPY upstream/LICENSE /opt/wechat-ai/LICENSE
COPY rpc.py /opt/ruanruan-reader/rpc.py
COPY live_database.py /opt/ruanruan-reader/live_database.py
ENV PYTHONPATH=/opt/wechat-ai/src OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
ENTRYPOINT ["/opt/ruanruan-reader/bin/python", "-u", "/opt/ruanruan-reader/rpc.py"]
