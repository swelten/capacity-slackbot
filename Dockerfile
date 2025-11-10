FROM public.ecr.aws/lambda/nodejs:20

# Install production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy application source
COPY src/ ./src/

# Lambda entrypoint
CMD ["src/index.handler"]
