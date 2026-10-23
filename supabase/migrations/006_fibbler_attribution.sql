-- Fibbler attribution: transparent scoring + contact tagging

-- Fibbler score breakdown on signals (shows how many points came from Fibbler)
ALTER TABLE signals ADD COLUMN IF NOT EXISTS fibbler_score integer DEFAULT 0;

-- Tag contacts influenced by Fibbler LinkedIn ads
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS fibbler_influenced boolean DEFAULT false;
