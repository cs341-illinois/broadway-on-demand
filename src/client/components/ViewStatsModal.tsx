import React, { ReactNode } from "react";
import { Modal, Button, Spinner } from "react-bootstrap";

interface ViewStatsModalProps {
  show: boolean;
  onCancel: () => void;
}

const ViewStatsModal: React.FC<ViewStatsModalProps> = ({
  show,
  onCancel,
}) => {
  return (
    <Modal show={show} onHide={onCancel} centered>
      <Modal.Header closeButton>
        <Modal.Title>View Stats</Modal.Title>
      </Modal.Header>
      <Modal.Body>Hello</Modal.Body>
      <Modal.Footer>
      </Modal.Footer>
    </Modal>
  );
};

export default ViewStatsModal;
