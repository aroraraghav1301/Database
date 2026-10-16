CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u text;
BEGIN
  u := lower(coalesce(nullif(NEW.raw_user_meta_data->>'username',''), split_part(NEW.email,'@',1)));
  IF EXISTS (SELECT 1 FROM public.profiles WHERE username = u) THEN
    u := u || '_' || substr(NEW.id::text,1,4);
  END IF;
  INSERT INTO public.profiles (id, username) VALUES (NEW.id, u);
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TABLE public.databases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  name text NOT NULL DEFAULT 'my_database',
  data jsonb NOT NULL DEFAULT '{"tables":{}}'::jsonb,
  api_key text NOT NULL DEFAULT encode(gen_random_bytes(24),'hex'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.databases TO authenticated;
GRANT ALL ON public.databases TO service_role;
ALTER TABLE public.databases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own dbs select" ON public.databases FOR SELECT TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "own dbs insert" ON public.databases FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "own dbs update" ON public.databases FOR UPDATE TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "own dbs delete" ON public.databases FOR DELETE TO authenticated USING (auth.uid() = owner_id);

CREATE POLICY "own files select" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'brace-files' AND EXISTS (SELECT 1 FROM public.databases d WHERE d.id::text = (storage.foldername(name))[1] AND d.owner_id = auth.uid()));
CREATE POLICY "own files insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'brace-files' AND EXISTS (SELECT 1 FROM public.databases d WHERE d.id::text = (storage.foldername(name))[1] AND d.owner_id = auth.uid()));
CREATE POLICY "own files delete" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'brace-files' AND EXISTS (SELECT 1 FROM public.databases d WHERE d.id::text = (storage.foldername(name))[1] AND d.owner_id = auth.uid()));