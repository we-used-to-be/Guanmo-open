-- Rust owns the estimate for frontend warmup and foreground admission.
-- JSON text lives for one 64-row batch; decoded Float32 vectors stay in the index.
WITH chunk_sizes AS (
  SELECT c.id,
    length(CAST(c.content AS BLOB))
      + length(CAST(COALESCE(c.title_path, '') AS BLOB))
      + length(CAST(COALESCE(c.heading, '') AS BLOB)) AS text_bytes,
    COALESCE(length(CAST(e.embedding AS BLOB)), 0) AS json_bytes,
    CASE WHEN json_valid(CAST(e.embedding AS TEXT))
      THEN COALESCE(json_array_length(CAST(e.embedding AS TEXT)), 0)
      ELSE 0 END AS vector_elements
  FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id
)
SELECT
  COALESCE(SUM(text_bytes), 0) AS text_bytes,
  COALESCE(SUM(vector_elements), 0) AS vector_elements,
  COUNT(*) AS chunks,
  (SELECT COUNT(*) FROM documents) AS documents,
  (SELECT COALESCE(SUM(length(CAST(file_path AS BLOB)) + length(CAST(title AS BLOB))), 0)
     FROM documents) AS document_bytes,
  (SELECT COALESCE(SUM(batch_bytes), 0) FROM
    (SELECT text_bytes + json_bytes AS batch_bytes FROM chunk_sizes
     ORDER BY batch_bytes DESC LIMIT 64)) AS batch_bytes
FROM chunk_sizes
