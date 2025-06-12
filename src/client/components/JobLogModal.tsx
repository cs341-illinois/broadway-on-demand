// src/components/JobLogModal.tsx
import React from "react";
import { Modal, Button, Spinner } from "react-bootstrap";

interface JobLogModalProps {
  show: boolean;
  handleClose: () => void;
  logContent: string | null;
  runId: string | null;
}

const JobLogModal: React.FC<JobLogModalProps> = ({
  show,
  handleClose,
  logContent,
  runId,
}) => {
  return (
    <Modal show={show} onHide={handleClose} size="lg" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title>
          Job Log: {runId ? <code>{runId}</code> : "Log"}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {logContent === null ? (
          <div className="text-center">
            <Spinner animation="border" role="status">
              <span className="visually-hidden">Loading log...</span>
            </Spinner>
            <p className="mt-2">Loading log...</p>
          </div>
        ) : (
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {logContent || "No log content available."}
          </pre>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={handleClose}>
          Close
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default JobLogModal;
