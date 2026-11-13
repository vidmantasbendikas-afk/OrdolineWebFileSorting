# Python reference evaluation of the model (tools/ground_truth.py), independent of the browser pipeline.
FROM python:3.12-slim
RUN pip install --no-cache-dir onnxruntime==1.32.0 pillow==13.0.0 numpy==2.5.4
WORKDIR /work
ENV HOME=/tmp
CMD ["python", "tools/ground_truth.py"]
