/**
 * vectoriadb Demo
 *
 * Demonstrates in-memory vector database with TF-IDF embeddings
 */

import { TFIDFVectoria } from 'vectoriadb';

interface DocMetadata {
  id: string;
  category: string;
}

function main() {
  console.log('=== vectoriadb Demo ===\n');

  // Create a TF-IDF based vector database (no external dependencies)
  console.log('1. Creating TF-IDF vector database...');
  const db = new TFIDFVectoria<DocMetadata>();
  console.log('   Database initialized\n');

  // Sample documents
  const documents = [
    {
      id: '1',
      text: 'JavaScript is a popular programming language for web development',
      metadata: { id: '1', category: 'programming' },
    },
    { id: '2', text: 'TypeScript adds static typing to JavaScript', metadata: { id: '2', category: 'programming' } },
    { id: '3', text: 'Machine learning enables computers to learn from data', metadata: { id: '3', category: 'ai' } },
    { id: '4', text: 'Neural networks are a key component of deep learning', metadata: { id: '4', category: 'ai' } },
    {
      id: '5',
      text: 'Node.js allows running JavaScript on the server',
      metadata: { id: '5', category: 'programming' },
    },
  ];

  // Insert documents
  console.log('2. Inserting documents...');
  for (const doc of documents) {
    db.addDocument(doc.id, doc.text, doc.metadata);
    console.log(`   Added: "${doc.text.substring(0, 40)}..."`);
  }

  // Reindex after adding documents
  console.log('   Reindexing...');
  db.reindex();
  console.log();

  // Search for similar documents
  console.log('3. Searching for "JavaScript programming"...');
  const results1 = db.search('JavaScript programming', { topK: 3 });
  console.log('   Top 3 results:');
  for (const result of results1) {
    const doc = db.getDocument(result.id);
    console.log(`   - [${result.score.toFixed(3)}] ${doc?.text.substring(0, 50)}...`);
  }
  console.log();

  // Another search
  console.log('4. Searching for "artificial intelligence"...');
  const results2 = db.search('artificial intelligence', { topK: 2 });
  console.log('   Top 2 results:');
  for (const result of results2) {
    const doc = db.getDocument(result.id);
    console.log(`   - [${result.score.toFixed(3)}] ${doc?.text.substring(0, 50)}...`);
  }
  console.log();

  // Get document count
  console.log('5. Database statistics:');
  console.log(`   Total documents: ${db.getDocumentCount()}`);
  console.log();

  // Delete a document
  console.log('6. Deleting document "3"...');
  db.removeDocument('3');
  db.reindex();
  console.log(`   New document count: ${db.getDocumentCount()}`);
  console.log();

  console.log('=== Demo Complete ===');
}

main();
